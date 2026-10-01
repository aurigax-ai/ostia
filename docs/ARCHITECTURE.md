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
| UI | React 18 + TypeScript strict, zustand, Tailwind v4, shadcn on Base UI, Phosphor icons (`@phosphor-icons/react`), cmdk |
| Terminal | node-pty in main; `@xterm/xterm` 6 + fit, search, web-links, unicode11, webgl addons (WebGL renderer, DOM fallback; `behavior.gpuAcceleration`) |
| Splits | allotment |
| Editor | monaco-editor with locally bundled workers; hand-written LSP client over `vscode-jsonrpc` |
| File viewers | `<img>` from a blob URL for images; `pdfjs-dist` (legacy build) for PDFs |
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
   ├─ unix socket (JSON-RPC) ── pine CLI (in each pane's shell)                          └─ <webview> guests (browser + extension panels)
   │                        └── extension processes (src/extensions, ~/.config/pine/extensions)
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
- **extensions** (`src/extensions/`): built-in extensions (git, trellis, keeper, system) and their SDK. They run
  as separate processes and reach pine only through the control socket (§11).

Every window uses `contextIsolation`, `sandbox`, no `nodeIntegration`, and `webviewTag: true`
(for browser panes). External links are denied in-window and opened by the OS. Windows are
frameless: macOS keeps native traffic lights (`titleBarStyle: hidden`); Linux/Windows draw their
own min/max/close (`WindowControls.tsx`). There is one main window plus any number of detached
windows (§2 Windows).

### Windows

A workspace (or a single pane, which becomes a new workspace on the same folder) can move into a
detached window so it can live on another monitor. Every window runs the same renderer bundle;
`windows.info()` tells a renderer whether it is detached.

- **Ownership moves with the workspace.** Each renderer owns only its own workspaces and layouts.
  `main/windowBroker.ts` is the broker: the source renderer sends the workspace as a handoff (a
  `SnapshotWorkspace` built by `workspaceHandoff`, which also carries `hibernated` marks) over
  `windows:detach`; main validates it (`parseHandoff`), checks the sender owns every pane
  (`panesOwnedBy`) and the workspace (the window reports), opens the window, moves ownership, and
  only then does the source release it (`workspacesStore.release` / `layoutStore.releasePane`),
  which emits no `pane-closed` or `workspace-closed`. The new window gets the workspace as its
  `workspace.load()` result and hydrates it, so pane ids are adopted, never minted.
- **Moving ownership** (`moveOwnership`): `rehomePanes` updates each `PaneIdentity.windowId`
  (tokens are kept, so an agent in the pane keeps working), `approvals.rehome` moves pending cards
  and history to the new window, and `holdPtys` marks the ptys as moving. Why the hold: the target
  attaches a terminal only when its host has a size, so a hidden or zoomed-away pane could stay
  unattached past `DETACH_GRACE_MS` and get reaped. A moving pty is never reaped for lacking an
  owner; the hold ends on the next `pty:attach` or on `pane-closed` (which then kills it if no
  owner is attached).
- **Ids never collide across windows.** Every renderer mints ids in its own random namespace
  (`lib/idNamespace.ts`: `pane-3fa9c2-4`, `w3fa9c2-2`), set at boot before anything is minted.
  Why: two renderers with separate counters minted the same `pane-5`, and a restored window could
  mint an id a pane in another window already held. Adopted ids keep their old namespace.
- **Closing a detached window** moves its workspaces back into the main window instead of killing
  them: the window's `close` is prevented, main asks the renderer (`windows:return-request`), the
  renderer confirms only unsaved files (a `move` close-confirm) and sends its handoffs over
  `windows:return`, main rehomes them, sends `windows:adopt` to the main window and closes the
  detached one. A crashed or loading renderer returns its last saved snapshot instead. Closing
  the main window quits the app (through the close guard), so the detached windows reopen on the
  next start. A detached window whose last workspace closes closes itself.
- **Cross-window lists.** Each renderer reports a small summary of its workspaces (display name,
  folder, live state, latest unread time, pane ids and titles) over `windows:report`; main
  broadcasts all of them as `windows:list`, main window first. The main rail shows other windows'
  workspaces after its own, marked with an app-window icon; a click focuses that window
  (`windows:focus-workspace` → `windows:activate-workspace`). `Ctrl+1..9`
  (`globalWorkspaceOrder`), jump to latest unread (`latestRemoteUnread`), the palette's workspace
  list and the notification center (`notifications:reveal`) use the same list and focus the
  owning window.
- **A detached window** has no rail and a title bar with only the project name (the workspace
  display name) and a Move back to main window button (`DetachedTitleBar.tsx`); the OS title
  follows `appearance.windowTitle`. New workspace from a detached window opens in the main window
  (`windows:new-workspace` → `workspace.new` there).
- **What a move does not carry**: renderer-only state starts fresh in the new window. Terminal
  blocks are rebuilt from the replayed ring (its OSC 133 marks), attention and zoom are reset,
  browser `<webview>`s reload their URL, editors reopen from disk (unsaved changes are confirmed
  first), diff panes are dropped (their content lives in `diffStore`, like restore), and the
  workspace's Ask conversation stays behind (Ask lives in each window's palette and works in a
  detached window, with its own history). The project (`name`, `projectDir`, `workDir`) and the
  auto-resume marks (`agentRunning`) do travel with the handoff. Dragging
  a tab out of the window is not built.
- **Settings stay in step**: when a renderer writes `settings.json` through `fs:write`, main sends
  `settings:changed` to the other windows, which reload it. Why: each renderer keeps its own
  settings store, and a stale one would write its old copy back over the change.
- **Security**: every window, detached included, is built by `createWindow` with
  `baseWebPreferences()`. Pane-keyed IPC keeps checking the sender: `pty:attach` refuses a pane
  another window owns, `browser:unregister` and lifecycle events from a window that no longer
  owns the pane are ignored.

### Main module map

| File | Owns |
|---|---|
| `index.ts` | App and window lifecycle, all core IPC handlers, pty spawn/attach, scrollback autosave, quit sequence, `execCommand` (control plane → renderer) |
| `windowBroker.ts` | Detached windows: window slots, workspace handoff between windows, ownership moves, the per-window reports and `windows:*` IPC, `workspace:save`/`load` (§2 Windows, §8) |
| `windowBook.ts` | Pure: per-window snapshots merged into one `workspaces.json`, split back per window, `clampBounds` for restoring onto connected displays |
| `ptySession.ts` | `PtySession`: one pty fanned out to many subscribers (owners write and keep it alive; observers read) |
| `ptyRingBuffer.ts` | Capped output ring with a monotonic cursor; `since(cursor)` reports `dropped` when the cursor fell off |
| `ptyReaper.ts` | Pure: when a pty with no owner is reaped (`orphanVerdict`), the per-window recovery grace (`RecoveryBook`), and which detached ptys a recovered window keeps (`planRecovery`) (§4 Pty lifecycle) |
| `appLog.ts` | The main-side app log `userData/logs/main.log` on electron-log's file transport: one line per event, values redacted (`redactSecrets`) and clipped, rotated at 1 MiB keeping 3 files |
| `diagnostics.ts`, `rendererReports.ts` | What goes into the app log (renderer and child process gone, unresponsive, failed loads, main uncaught errors, renderer console errors, reloads), the crash reload, and the `diagnostics:*` IPC with its validation and rate limit (§4 Crashes and diagnostics) |
| `shellIntegration.ts` | Generates zsh/bash init files that emit OSC 133 + OSC 7 and define the `pine()` shell function |
| `privateTmp.ts` | Per-uid, mode-0700 temp dir for those files |
| `screenMirror.ts` | `ScreenMirror`: a headless xterm per pty fed every byte; `serialize()` is the width-independent history saved to `scrollback.json` |
| `workspaceSnapshot.ts` | Reads/validates/writes `workspaces.json` and `scrollback.json`; one-shot restored scrollback |
| `pathGuard.ts` | `resolveSafe` / `isPathAllowed` / `expandHome` for fs IPC and browser file outputs |
| `lsp.ts` | Spawns language servers found on `PATH`, relays JSON-RPC to the renderer |
| `controlServer.ts`, `controlAuth.ts`, `capabilityStore.ts`, `idRegistry.ts` | Control socket, token auth, per-pane capabilities, pane id ↔ external id ↔ token |
| `workspaceRegistry.ts` | Workspace id → workDir, fed by lifecycle events |
| `paneList.ts` | `pane.list`, `workspace.list` (maps renderer ids to external ids) |
| `events.ts` | In-process platform events (`notify`, `agent.needs-input`, `agent.done`, `workspace.state`, `pane.state`); only the gateway listens |
| `jsonStore.ts` | Atomic JSON persistence, project (`<workDir>/.pine/<name>.json`) or global (`$XDG_DATA_HOME/pine/<name>.json`) |
| `notify.ts` | The notification log (`notifications.json`), desktop notifications, `notify` / `notify.list`, `notifications:*` IPC (§5) |
| `attention.ts` | `pane.setAttention` control method (`pine state`) |
| `processManager.ts`, `vault.ts`, `bus.ts`, `docs.ts` | Agent toolbelt control methods (§6) |
| `extensionHost.ts`, `extensionManifest.ts`, `extensionStore.ts` | Extension host: discovery + manifest validation, approval records, extension processes, `ext.*` control methods (§11) |
| `extensionConfirm.ts` | The native confirm dialog behind `ext.confirm` (§11) |
| `iconThemes.ts` | VS Code file icon themes from `contributes.iconThemes`: confined, size-capped loading into `data:` URLs, `iconThemes:load` IPC (§5) |
| `viewHost.ts`, `viewsIpc.ts` | Declarative views: confined loading of `~/.config/pine/views/*.json`, last good tree, enablement store, `views:*` IPC, `view.list` / `view.open` control methods (§11) |
| `workflows.ts` | Saved workflows: confined YAML loading (workspace, user, extension manifests), `workflows:list`/`workflows:save` IPC, `workflow.list` control method (§4) |
| `settingsSync.ts`, `settingsSyncIpc.ts` | Settings sync: pure plan/merge + the file executor; triggers (startup, window focus, local file changes) and `sync:*` / `dialog:pick-folder` IPC (§5) |
| `browse.ts`, `browseWorld.ts` | `browse.*` automation of browser panes, agent-browser contract; the isolated browse world (§9) |
| `browserStorage.ts` | Cookies and web storage of a browser pane: the storage viewer's `browser:storage-*` IPC and the agent `cookies`/`storage` verbs (§9) |
| `browsePick.ts`, `guestNetwork.ts` | Pick element: `browse.pick`, `browser:pick-*` IPC, UI-issue reports; failed-request buffer per guest (§9) |
| `selectionReport.ts` | Send-selection reports from file views: `selection:send` IPC, `selection-N.md` + PNG (§9) |
| `fsBinary.ts` | `fs:read-binary`: confined, size-capped byte reads for the image and PDF viewers (§9) |
| `externalEditor.ts` | "Open in External Editor": resolves `behavior.externalEditor` (or auto-detects code/cursor/zed on `PATH`) and spawns it with an argv array (§9) |
| `notifyCommand.ts` | Runs `notifications.command` for each recorded notification: argv split, placeholders `{title}` `{body}` `{pane}`, `shell: false` (§5) |
| `gateway/` | LAN gateway: `index.ts` (methods + IPC), `server.ts`, `controlDispatch.ts`, `devices.ts`, `pairing.ts`, `cert.ts`, `interfaces.ts` (§7) |

Why the control-plane modules never import `main/index.ts`: that creates an import cycle.
`index.ts` passes its functions in instead (`registerControlServer(deps)`,
`registerPaneListMethods`, the gateway's deps).

### Data locations

- `~/.config/pine/settings.json` (Electron `userData`): settings, including `capabilities.grants`.
- `userData/gateway/{cert,key}.pem`: gateway TLS identity.
- `userData/logs/main.log` (+ `main.1.log`, `main.2.log`): the app log (§4 Crashes and diagnostics).
- `$XDG_DATA_HOME/pine/` (default `~/.local/share/pine/`): `workspaces.json`, `scrollback.json`,
  `notifications.json`, processes, bus, global vault, `gateway-devices.json`,
  `gateway-config.json`, `gateway-pair-audit.log`.
- `$XDG_CONFIG_HOME/pine/workflows/*.yaml|yml` (user) and `<workDir>/.pine/workflows/*.yaml|yml`
  (project): saved workflows (§4).
- `<workDir>/.pine/`: project-scoped vault. Older versions also kept a kanban `board.json` and a
  `wiki.json` here (and a global `$XDG_DATA_HOME/pine/wiki.json`); those extensions were removed in
  favour of Trellis, and pine leaves the files in place without reading them.
- `userData/extensions.json`: per-extension `{enabled, approved}` records (§11).
- `$XDG_DATA_HOME/pine/`: `chat-sessions/<id>.json` (assistant chats), `extension-secrets.json`
  and `mcp-secrets.json` (encrypted with `safeStorage`, never synced; §11).
- `$XDG_CONFIG_HOME/pine/views/<name>.json`: declarative views; `userData/views.json`: which of
  them the human enabled (§11). Neither is synced.
- `userData/sync-state.json`: the sync folder last synced with, a hash per synced file at the
  last sync, the last sync time and the last conflict (§5). The sync folder itself holds
  `settings.json`, `extensions.json` and any `*.conflict-<time>-<host>.json` copies.
- Built-in extensions: `out/extensions/<id>/` in dev, `resources/extensions/<id>/` when packaged.
  User extensions: `$XDG_CONFIG_HOME/pine/extensions/<id>/` (default `~/.config/pine/extensions`).
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
| fs | `list`, `read`, `write`, `readBinary` (confined by `resolveSafe` to `[homedir, userData]`; `readBinary` returns a `Uint8Array`, capped at 50 MiB) |
| lsp | `list`, `start`, `send`, `stop`, `onMessage`, `onExit` |
| settings / workspace | `settings.path`; `workspace.save`, `workspace.load` (both answered for the sender's own window) |
| windows | `info`, `detach`, `returnToMain`, `report`, `focusWorkspace`, `returnWorkspace`, `newWorkspace`, `onList`, `onAdopt`, `onActivateWorkspace`, `onReturnRequest` (push channels `windows:list`, `windows:adopt`, `windows:activate-workspace`, `windows:return-request`) |
| lifecycle | `lifecycle.emit` (`pane-created`, `pane-closed`, `workspace-added`, `workspace-closed`, `workspace-activated`, `workspace-state`) |
| commands | `publish` (renderer's command list), `onInvoke` (run a command for main) |
| terminal state | `terminalState.push` |
| browser | `register`, `unregister`, `pickStart`, `pickCancel`, `pickSend`, `onPickState` (push channel `browser:pick-state`), `storageRead`, `storageSet`, `storageRemove`, `storageClear` (IPC `browser:storage-*`) |
| selection | `selection.send({capture, image?, sourcePaneId, targetPaneId, note})` (IPC `selection:send`, §9) |
| extensions | `list`, `setEnabled`, `approve`, `invoke`, `panel` (context may carry a `path`), `sidebarItems`, `paneChips`, `setSetting`, `onChanged`, `onSidebar`, `onPaneChips`, `onOpenPanel`, `onOpenDiff`, `onOpenTerminal` (push channels `extensions:changed`, `extensions:sidebar`, `extensions:chips`, `extensions:open-panel`, `extensions:open-diff`, `extensions:open-terminal`) |
| external editor | `externalEditor.open({template, file, line?, column?})` (IPC `editor:open-external`, §9) |
| gateway | `enable`, `disable`, `pair`, `status`, `devices`, `revoke`, `bind-options`, `set-cap` (IPC only) |
| notifications | `list` (newest first), `post`, `clear`, `reveal` (focus the window that owns a pane), `onChanged`, `onActivate` (push channels `notifications:changed`, `notifications:activate`) |

- Main derives the window from `e.sender.id` and never trusts a window id the renderer sends.
- `pane-closed` drops the pane's capabilities, identity, pending restored scrollback and cached
  terminal state.
- The gateway and extension-management IPC (`extensions:set-enabled`, `extensions:approve`)
  skip capability checks. Only Pine's own renderer can call them, and it is the trusted UI. The
  socket and gateway enforce capabilities for everything else. There is deliberately no socket
  method or CLI verb that approves or enables an extension.
- `extensions:invoke` passes the command's own declared capabilities as the caller's caps, not
  all of them. Why: an agent can reach a palette command through `command.exec`, which already
  checked those caps; handing the extension more would let an agent launder a palette call into
  a stronger caller.
- Path containment in `pathGuard` is lexical. A symlink inside home that points outside is not
  caught.

## 4. Terminal

### Pty lifecycle

Ptys live in main keyed by renderer pane id (see CLAUDE.md §4). Spawn happens on the first
`pty:attach`, at the size the renderer actually fitted (see CLAUDE.md §6 for the sizing
dragons). Terminal name `xterm-color`.

Spawn env: `PINE_PANE_ID` (the external id, not the renderer id), `PINE_TOKEN`, `PINE_SOCKET`,
`PINE_START_DIR` (despite the name, the pane's spawn cwd), `PINE_CLI` (`out/cli/index.js`),
`PINE_NODE` (`process.execPath`), `PINE_SHELL_STATE` (a random file in
`privateTmpDir('pine-shell-state')` the shell writes its PATH and command names to, removed
when the pty goes; see the input editor in §Terminal), plus the shell-integration env.

- The live ring is capped at 1 MB. `pty:attach` returns a replay from the ring; `pty:detach`
  starts `DETACH_GRACE_MS` (3 s) before the pty is reaped. The timer never kills directly: it
  asks `orphanVerdict` (`ptyReaper.ts`), which keeps a pty that has an owner again, is moving
  between windows, or is held for a recovered window, and waits while its window is recovering.
  Every kill goes through `killPty(paneId, reason)` and is logged as `pty-reap` with
  `grace-expired`, `closed` (the pane was closed, a recovered window no longer shows it, or its
  window closed), `restart`, `hibernated`; a shell that exits on its own is logged as `pty-exit`.
- `pty:hibernate` (agent hibernation, §5) serializes the pane's `ScreenMirror` into the restored
  scrollback map (`stashScrollback`), drops the pty's window subscribers so no `[process exited]`
  reaches the renderer, kills the pty and forgets its terminal state. The next `pty:attach` for
  that pane spawns a fresh shell and replays the stash behind a `woke from hibernation` seam
  (bare OSC 133;D first, like the restore seam). Why reuse the restored-scrollback map: it is
  already merged into every `scrollback.json` save, so quitting while a pane sleeps keeps its
  history, and it is dropped with the pane on `pane-closed`.
- Children of a pty inherit the Electron main process's open file descriptors, sockets
  included (Chromium's and Playwright's debugging listener among them). Anything that maps
  sockets to a pane's processes must discount the ones main also holds (the ports extension
  does).
- The window `closed` handler removes that window's subscriber from every pty. Why: a crashed or
  force-closed window never sends `pty:detach`, and without this the ptys leak. Browser panes are
  pruned before `removeWindow()` because pruning needs the registry entries.
- Renderer attach order (`Terminal.tsx`): subscribe `onData`, then attach, then dispose the pane's
  markers and call `blocksStore.resetPane`, then write the replay, then flush queued bytes.
  `resetPane` also bumps the pane's generation, which lets main reject stale terminal-state snapshots.

### Crashes and diagnostics

Main writes `userData/logs/main.log` (`appLog.ts`, electron-log's file transport with our own
rotation: `main.log`, `main.1.log`, `main.2.log`, 1 MiB each, mode 0600). Logged:
`app-start`/`app-quit`, `render-process-gone` and `guest-process-gone`, `child-process-gone`,
`window-unresponsive`/`window-responsive`, `did-fail-load`, `main-uncaught-exception` /
`main-unhandled-rejection`, `renderer-console-error` (console messages at error level),
`renderer-error` (reports from the renderer), `window-reload`, `window-recovering` /
`window-recovered`, `pty-reap`, `pty-exit`. Only event fields go in: never terminal output,
environment, tokens or settings. Free text (error messages, stacks, console text) passes
`redactSecrets` (key=value secrets, bearer tokens, `sk-`/`gh*_` keys, long opaque strings) and is
clipped. Why not log pty bytes for context: they carry whatever the user typed, passwords included.

The renderer reports `window` `error` and `unhandledrejection` events (`lib/errorReporting.ts`)
over `diagnostics:report`; main accepts only the known kinds with a string message
(`normalizeRendererReport`: control characters stripped, message 1000 / stack 8000 chars) and at
most 20 reports and 20 console errors per window per minute (`ReportLimiter`, a
`renderer-reports-suppressed` line counts the rest). `App` sits in `AppErrorBoundary`
(`main.tsx`): a render error shows the recovery screen (the error, Reload window, Copy details,
Open log folder) and reports kind `render`. Each surface sits in its own `SurfaceErrorBoundary`
(`SurfacePool.tsx`), so a pane that throws while rendering shows its error and Close pane while
the rest of the window keeps working. Why the app boundary is still needed: React 18 unmounts the
whole root on an error that no boundary catches, and an error thrown by an effect cleanup of a
pane being removed reaches only boundaries above that pane (its own boundary is being removed
with it). That unmount runs every `TerminalView` cleanup, which detaches every pty; before the
recovery grace, main reaped them all 3 s later and wrote an empty `scrollback.json` (the closed
diff tab crash, CLAUDE.md §6).

Recovery (`RecoveryBook`): a window is recovering from a `render` report, a main-frame reload
(`did-start-navigation` after the first load), `diagnostics:reload-window`, or
`render-process-gone` (main reloads the window, at most 3 times a minute). While it recovers, a
detached pty of that window waits for up to `RECOVERY_GRACE_MS` (10 min) instead of 3 s. After
the first render the renderer sends `diagnostics:ready` with every pane id in its layout;
`finishRecovery` keeps detached ptys of listed panes until they attach (a parked workspace
attaches only when shown) and reaps the rest as `closed`. A boot that throws (settings, theme,
restore) renders `RecoveryScreen` directly. Palette: Developer: Toggle Developer Tools (also in
packaged builds; agents need `destructive`) and Developer: Open Log Folder. E2E builds expose a
test crash: with `NODE_ENV=test` `diagnostics:test-hooks` is true and `CrashTestHook` throws on
`diagnostics:test-crash`.

### Shell integration

`shellIntegration.ts` writes init files into `privateTmpDir('pine-shell-integration')`, which is
`tmpdir()/pine-shell-integration-<uid>` with mode 0700. The dir is refused if it is a symlink or
owned by another user. Why: on a shared `/tmp`, another user could plant rc files your shell sources.

Marks emitted: OSC 133 A/B/C/D (prompt start, prompt end, command start, command end + exit code),
OSC 7 (cwd), and OSC 633;E (the exact command line, escaped `\\` / `\xHH`, sent just before C).
Why E: a command read back off the screen picks up a right-aligned RPROMPT and misses text that
was pasted or inserted from history; the shell's own `preexec` argument is exact.

- **zsh**: a generated `ZDOTDIR` whose `.zshenv` and `.zshrc` source the user's real files. If
  the user's `.zshenv` itself changes `ZDOTDIR`, the generated `.zshenv` records the new value
  as `PINE_ZDOTDIR_ORIG` and resets `ZDOTDIR` to Pine's dir. Why: otherwise Pine's `.zshrc` is
  skipped and integration silently vanishes.
- **bash**: `--rcfile`. The OSC 133;B mark is appended after the user's `PROMPT_COMMAND` runs,
  because starship and powerline rebuild `PS1` there. A bash 5.1 array `PROMPT_COMMAND` is kept
  and each element is eval'd.
- **Pine prompt**: with `PINE_PROMPT=pine` in the spawn env, the generated init (which runs
  after the user's rc and prompt framework) unsets it and, in each prompt hook after the user's
  own, sets `PROMPT` to `%~`, a newline and `<sep> ` and clears `RPROMPT` (zsh), or `PS1` to
  `\w\n<sep> ` after the user's `PROMPT_COMMAND` (bash); with `PINE_PROMPT_LINES=1` (same-line
  prompt) it is one line, `%~ <sep> ` / `\w <sep> `. The B mark is then appended as usual. Why
  two lines: the editor draws the chip row over the cwd line, so the input row keeps the shell's
  own separator and scrollback still reads `cwd` / `$ command`. powerlevel10k is torn
  down once (`prompt_powerlevel9k_teardown`). Why the teardown: p10k rebuilds `PROMPT` from its
  own hooks and zle widgets (async segments), so a plain assignment would flicker back.
- **Other shells** spawn with no integration.
- **`pine()` shell function**: it runs `ELECTRON_RUN_AS_NODE=1 $PINE_NODE $PINE_CLI`, so no
  system Node is needed. electron-builder unpacks `out/cli/**` from the asar for this.

- **Claude plugin** (`shellIntegration.ts` `writeClaudePlugin`): the generated init defines
  `claude() { command claude --plugin-dir <dir>/claude-plugin "$@"; }`. The plugin holds the
  `pine` skill (`src/main/agent/pine-skill.md`, the single copy; `.claude/skills/pine/SKILL.md`
  links to it) and `hooks/hooks.json` (`claudeHookSettings`: `pine resume-token`, `pine state`).
  Why a session plugin and not the user's config: we never write the user's dotfiles or
  `~/.claude`, and a session plugin adds a skill and hooks without replacing theirs. Why a plugin
  and not `--settings`: settings can't carry a skill, so Claude outside this repo never learned
  the `pine` CLI (cmux and Warp ship skills or plugins for the same reason).
- **Codex hooks** (`shellIntegration.ts` `codexWrapper`, `codexHookArgs`): the generated init
  defines `codex()`, which prepends `__pine_codex_hook_args` only when
  `__pine_codex_starts_session` says the call starts an interactive session (bare `codex`,
  `codex [prompt]`, `codex resume`, `codex fork`; option values are skipped, `--` means a
  prompt follows). `exec`, `review`, `login`, `mcp` and every other subcommand, `--help` and
  `--version` run untouched. The args are `--no-daemon`, one `-c hooks.<Event>=[…]` per event
  (`codexHookCommands`: `SessionStart` → `pine resume-token codex -` plus `cat` of
  `<dir>/codex/session-context.md`, `UserPromptSubmit` → `state working`, `PermissionRequest` →
  `state waiting -`, `Stop` → `state done`) and one `-c hooks.state={…}` that marks each of those
  handlers trusted. Verified against codex-cli 0.157.0.
  - Why `-c` and not `~/.codex/hooks.json`: `-c` values form Codex's session-flags config
    layer, which is added after the user and project layers and replaces nothing in them, so
    the user's own hooks still run and `~/.codex` is never written.
  - Why `hooks.state` and not `--dangerously-bypass-hook-trust`: Codex runs a non-managed hook
    only if `hooks.state["<source>:<event>:<group>:<handler>"].trusted_hash` equals the hook's
    hash. The bypass flag would also run every unreviewed user and project hook in that
    process. Session-flag hooks have the source `/<session-flags>/config.toml`, and the key
    contains a `.`, which `-c`'s dotted path would split, so the whole `state` table is one
    inline-table value. `codexHookTrustHash` rebuilds Codex's hash (`hook_hash` in
    `codex-rs/hooks/src/engine/discovery.rs`): SHA-256 of the key-sorted, compact JSON
    `{"event_name":"<snake_case event>","hooks":[{"async":false,"command":…,"timeout":600,"type":"command"}]}`.
    A test pins one hash that codex 0.157 reported through `hooks/list`. If a future Codex
    changes that identity, the hooks show as untrusted in `/hooks` and don't run; they are never
    run unreviewed.
  - Why `--no-daemon`: Codex 0.157 can run the TUI's sessions in a shared background
    app-server. Hooks run with that server's environment, so they would report to the pane
    that started the server, not this one. Any `-c` other than a few feature flags already
    keeps the TUI off the shared server; the flag makes it explicit.
  - Why the skill arrives as `SessionStart` context and not as a skill: Codex 0.157 finds
    skills only in its config folders, `~/.agents/skills` and the repo; `skills.config` entries
    only enable or disable skills already found, and no flag adds a root. `developer_instructions`
    would replace the user's own value. A `SessionStart` hook's plain stdout is added to the
    model's context, so the second handler prints a short note that names the `pine` CLI and the
    path of the skill (`<dir>/codex/SKILL.md`, written from `pine-skill.md`) for Codex to read.
  - Why `SessionStart` is enough for the resume token: Codex fires it at the first turn of a
    session with `source` `startup`, `resume`, `fork`, `clear` or `compact`, and its
    `session_id` is the id `codex resume <id>` takes. A session with no turn yet has no id
    recorded.

### Rendering, blocks, state

- `Terminal.tsx` registers OSC 7 (cwd, raw path) and OSC 133 A/B/C/D handlers. Scrollback, wheel
  speed and minimum contrast come from the `terminal` settings and are re-applied to open terminals.
  Web links open on Ctrl/Cmd+click. `TerminalFind.tsx` wraps the search addon.
- **Blocks** (`stores/blocksStore.ts`, `components/Blocks.tsx`):
  - Each OSC 133 mark registers an xterm marker (`registerMarker(0)`), which tracks its line
    through reflow and trimming. Line -1 means the line was trimmed away.
  - A→C is the draft; C→D is a running block. At most 200 blocks are kept per pane.
  - A second C with no D closes the previous block. Why: a D can be lost to buffer truncation.
  - Each block stores its command text, read at C from the B position (marker line + cursor
    column) to the C position (`readCommandText`, `lib/blockText.ts`), and the cursor column at
    D (`endCol`). Why read at C: OSC handlers run synchronously mid-parse, so the buffer holds
    exactly what the shell echoed; later reflow or trimming can't change it. Why `endCol`:
    output without a trailing newline (`printf abc`) ends on the D row, and without the column
    the last line would be dropped, or the next prompt copied with it.
  - Text extraction (`readBufferText`) joins rows whose successor `isWrapped`, reading the
    wrapped row untrimmed so a space on the wrap boundary survives, then trims each logical line
    and drops trailing blank lines. It always reads `buffer.normal`, because block markers live
    there even while a TUI has the alternate screen up.
  - The overlay redraws on `onRender`/`onScroll` and skips the React update when the geometry
    is unchanged. It draws up to 80 left-edge gutter bars (prompt line to D; red on non-zero
    exit) as buttons in the host's 6px left padding, so they never cover a text cell. The overlay
    itself stays `pointer-events: none`; only the gutter buttons and the sticky header take the
    pointer. Nothing is drawn in the alternate buffer or when the cell height measures 0.
- **Block selection and actions** (`lib/blockActions.ts`, `components/BlockMenu.tsx`):
  - Clicking a gutter bar toggles `blocksStore.selected[paneId]`; the selected block gets a
    `--line-strong` frame and a `--brand` bar. Escape clears it (the xterm key handler swallows
    Escape only while a block is selected, so vim and agents still get it); typing clears it too.
  - `Ctrl+Shift+↑/↓` (`⌘↑/⌘↓` on macOS) step the selection and scroll the block's first line
    into view. Why these chords: plain and Ctrl-only arrows belong to shells and TUIs (word
    motion, history), and Ctrl+Shift+arrows aren't bound by bash, zsh or the common agent CLIs.
    They're terminal chords, handled in the xterm key handler, not the window listener. Why:
    in text inputs and Monaco the same keys extend a selection, and the window listener's
    `preventDefault` would break that.
  - Right-click on a bar opens a Base UI context menu: copy command, output, or both; rerun.
    Closing it returns focus to the terminal so the chords keep working. Palette commands
    `block.selectPrev/selectNext/copyCommand/copyOutput/copyBoth/rerun` do the same on the
    active pane; with nothing selected they act on the latest block.
  - Rerun and history insertion paste through `term.paste` (bracketed paste when the shell asks
    for it), and only at an idle prompt: an open draft and nothing running. Why: anywhere else
    the keystrokes would go to whatever program is running. Both need the `shell` capability,
    which phones never map to.
  - `lib/terminalHandles.ts` maps pane id to its live xterm so commands can reach the buffer.
    An entry is removed on unmount only if it still points at the same terminal.
- **Sticky command header** (`Blocks.tsx` `StickyHeader`, `lib/blocks.ts` `stickyBlock`): when
  the newest block whose command line is above the viewport still has output in view, a 22px
  header shows its command and status (running, or `exit N`). Clicking scrolls to the command.
- **Command history search** (`components/HistorySearch.tsx`, `history.search`,
  `Ctrl+Shift+H` / `⌘⇧H`): lists every block's command across all panes and workspaces, newest
  first, deduped by text, with workspace and cwd; choosing one inserts it into the active pane's
  prompt without running it. Why not Ctrl+R: that's the shell's own history search. History is
  what's in `blocksStore`, so it covers panes that exist now (restored scrollback re-parses its
  marks on replay), not closed panes. Each row's save button opens "Save as workflow" with that
  command.
- **Saved workflows** (`shared/workflows.ts`, `main/workflows.ts`, `components/WorkflowPicker.tsx`,
  `components/SaveWorkflowDialog.tsx`, `workflows.search`, `Ctrl+Shift+S` / `⌘⇧S`): Warp's
  workflow YAML (`name`, `command` with `{{arg}}` placeholders, `description`, `tags`,
  `arguments[{name, description, default_value}]`, `shells`, `author`, `source_url`). Main reads
  them from three sources, in this order: the active workspace's `<workDir>/.pine/workflows/`,
  the user's `$XDG_CONFIG_HOME/pine/workflows/`, and `contributes.workflows` in the manifests of
  enabled, approved extensions. A file holds one workflow, a list, or several YAML documents.
  The renderer asks with a workspace id only (`workflows:list`); main resolves the workDir from
  `workspaceRegistry` and confines it with `resolveSafe`.
  - Why main validates and caps: workflow files come from repos the user clones. Main skips
    symlinked files and folders, files over 64 KiB, more than 200 files or 50 workflows per file,
    YAML aliases (billion-laughs), and anything `parseWorkflow` rejects (field lengths, argument
    names `[A-Za-z_][A-Za-z0-9_-]*`, http(s) `source_url` only). A bad file is reported as a
    problem (shown at the bottom of the picker and on stderr of `pine workflow list`), never a
    silent drop, and never stops the other files from loading.
  - Placeholders are `{{name}}` tokens in the command; `{{{name}}}` is a literal `{{name}}` (Warp's
    escape). Unlike Warp, a placeholder counts even if `arguments` doesn't declare it; declared
    arguments only add a description and a default. Why: the save dialog detects arguments from
    what the user typed into the command, and `{{ .Names }}`-style Go templates (spaces, dots)
    still pass through untouched. Values are substituted verbatim, not shell-quoted, like Warp:
    the form shows the exact line that will be inserted.
  - Choosing a workflow with arguments opens the form (defaults prefilled, the first argument
    focused, Tab to the next, placeholders highlighted in the live preview); one without arguments
    is inserted at once. Insertion is `insertCommand` without Enter, so it needs an idle prompt
    and fills the input editor when that is shown; anywhere else the command goes to the
    clipboard and the form says so before you confirm. There is no hidden "insert workflow"
    command and no run verb: only the human's click types, and agents run their own commands.
  - "Save as workflow" (block menu, command history) writes `<stem>.yaml` into the user folder
    (mode 0600, folder 0700) with `wx`, so an existing file is never overwritten (`-2`, `-3`…).
    The stem is an ASCII slug of the name, so a name can't escape the folder. Main re-validates
    the document with `parseWorkflow` before writing.
- **Input editor** (`components/InputEditor.tsx`, `lib/inputEditor.ts`, setting
  `behavior.inputMode: 'terminal' | 'editor'`, palette `terminal.toggleInputEditor`): in
  `editor` mode a Warp-style editor takes over the shell's input line. It is an overlay in
  `.terminal-stack` (above the block overlay) that places itself over the shell's own input
  cells: `usePromptGeometry` reads xterm's cursor (an idle prompt's cursor is where input
  starts), measures cells from `.xterm-screen` and `placePrompt` (`lib/promptOverlay.ts`) picks
  the row, the first column and the last column (just before a right prompt when at least
  `MIN_INPUT_COLS` fit). With the shell prompt style the shell's prompt stays visible to the
  left and the editor types after it, so there is one prompt, not two; with the Pine prompt the
  chip row covers the cwd line above (or, same-line, chips and separator cover the whole row).
  It shows only while the pane is at an idle prompt (`drafts[paneId]` open, nothing
  `running`), the normal buffer is active (`term.buffer.onBufferChange`), and the prompt is not
  suppressed. The textarea uses the terminal font, the cell height as line height and a letter
  spacing that makes its advance match xterm's cell width (`charWidth` measures the font on a
  canvas); it grows downward to eight lines, then scrolls. A draft taller than the rows under the
  prompt asks Terminal to scroll xterm locally (`scrollUpSequence`: move to the bottom row,
  write newlines, put the cursor back on the moved prompt) instead of covering output. Why
  in place and never docked: the docked editor showed the shell's prompt and its own at once,
  and resized the pty at every prompt; iTerm2's auto composer and Warp both draw the input
  where the prompt is. Why the local scroll is safe: the shell only moves the cursor relatively
  at a prompt, and the saved scrollback is logical lines, so the few blank rows never show up.
  The DOM renderer can drift a few pixels on a row with a fallback-font glyph (e.g. `❯`);
  WebGL draws by cell and doesn't.
  - Enter submits: an empty draft writes `\r`; otherwise `insertCommand(paneId, text, true)`,
    the same bracketed-paste-then-Enter path as rerun, so the shell receives exactly what typing
    would give it. Shift+Enter adds a newline, and a multi-line draft is pasted as one
    bracketed paste, so zsh/bash run it as one command line. Ctrl+C clears the draft. Escape
    closes the completion menu, else dismisses the suggestion, else (vim mode) enters normal
    mode, else hands off. Up on the first line (or while already walking) steps through
    `inputHistory`: this pane's commands newest first, then other panes' by start time, deduped;
    with text in the draft only entries that start with it (`historyMatches`, like zsh's
    up-line-or-beginning-search and fish).
  - Line editing (`lib/lineEditing.ts`): readline keys work on the current line of the draft:
    Ctrl+A/E/B/F, Alt+B/F (not on macOS, where Option types characters), Ctrl+K/U/W and
    Alt+D kill into a one-entry kill ring that Ctrl+Y yanks, Ctrl+H backspace, Ctrl+D delete (on
    an empty draft it sends EOF to the shell), Ctrl+P/N walk history, Ctrl+L sends `\x0c` so
    the shell clears the screen and redraws its prompt while the draft stays. Ctrl+C/V/X/Z stay
    with the textarea (clear, paste, cut, undo). Keys match by physical key (`KeyboardEvent.code`)
    so other layouts work.
  - Spec completions (`lib/specCompletion.ts`, `argumentCandidates` in `lib/inputEditor.ts`): Tab
    on a word that isn't the command asks main for the command's spec (cached per editor) and
    walks the finished words of the current simple command (`commandWords`: after the last
    operator, assignments before the command skipped, quotes removed) through it
    (`specAnswer`): an option's required arguments are skipped (`--opt=value` too), combined
    short flags count as used, a subcommand only in first positional place, persistent options
    carry down, `--` ends options. The current word then gets the option's argument values,
    options not used yet (when it starts with `-`), or subcommands plus the positional
    argument's suggestions; an argument with a `filepaths`/`folders` template, and any command
    without a spec, falls back to path completion (folders only for `folders`). The word decides
    which kind of answer it is; the menu's candidates are then every item of that kind (the
    spec walked again with only the word's leading `-`/`--`), so typing can filter them. The
    menu shows each spec item's description. Why converted at build time and not Fig's runtime:
    Fig specs are JS modules whose generators run shell commands and post-process output with
    code; Pine ships only their static data, so nothing from a spec executes. Specs over 4 MB
    with their `loadSpec` sub-specs expanded (aws, gcloud) are kept without them.
  - Hand-off (`shellKeyBytes`, `onHandOff` → Terminal `handOffInput`): any other Ctrl+letter or
    Alt+letter, and Escape with nothing to dismiss, suppresses the prompt, pastes the draft into
    the shell line (bracketed) and writes the key's bytes, then focuses xterm. Why: the shell's
    own widgets (Ctrl+R history search, fzf's Ctrl+T/Alt+C, Ctrl+X Ctrl+E) must keep working,
    and they need the text on the shell's line.
  - Suppression is keyed on the prompt's A marker (`draft.promptLine`), not the draft object.
    Submitting suppresses the prompt it was submitted at, so the editor hides immediately
    instead of waiting for OSC 133;C. A hand-off suppresses it too. Keys, a DOM paste and the
    paste chord aimed at xterm while the editor is shown go to the editor instead
    (`attachCustomKeyEventHandler` → `inputEditorFor(paneId).type/focus`), and a click on the
    terminal that leaves no selection focuses it, so the shell's line stays empty under the
    editor. Why the A marker: zsh
    re-emits B on every prompt redraw (p10k async segments, WINCH), which replaces the draft
    object; the A marker only changes with a new prompt.
  - While the editor is shown, `insertCommand` without Enter (history search, `history.insert`)
    fills the editor instead of the shell line (`registerInputEditor` in
    `lib/terminalHandles.ts`), and `focusSurface` focuses the editor rather than xterm.
  - Focus: when the editor appears and focus was already inside this terminal surface, the
    editor takes it; when it hides while focused (a command started), focus goes to xterm, so
    `cat`, `less`, vim or an agent CLI get every key. It never steals focus from another pane.
  - Autosuggestions: `historySuggestion` takes the first `inputHistory` entry (so this pane's
    newest command wins, then other panes') that starts with the draft and is longer, and the
    rest shows as ghost text after the caret. It shows only with the caret at the end of the
    draft, no selection, no open menu, not while walking history or composing, and not in vim
    normal mode. Right or End accepts it whole; Ctrl+Right (Alt+F on macOS) accepts the next
    word (`suggestionWord`: leading spaces plus one word). Escape hides it until the draft
    changes; typing that no longer matches drops it.
  - Tab completes the command name in command position (`isCommandWord`: the word the
    tokenizer would read as a command, first word or after `|`, `&&`, `;`, `$(`, past
    `FOO=1` assignments, without a `/`), and paths everywhere else. Commands come from
    `pty.commands(paneId)`, fetched each time a prompt shows; `commandCandidates` orders all of
    them (`rankCommands`: commands this history ran first, newest first, then shorter names,
    then alphabetical). Paths: the word before the caret (backslash-escaped spaces understood)
    is split into dir and base, the dir is resolved against the pane cwd (`resolveLinkPath`; `~`
    is expanded in main), and `fs.list` supplies the whole folder (`pathCandidates`). The
    completers return only candidates; `lib/completionMatch.ts` matches them against the base
    (`filterCompletions`: exact-case prefix, then any-case prefix, then substring, then
    subsequence, pool order kept within a tier; dotfiles need a leading dot). Tab (`tabStep`)
    inserts the one prefix match (or the one match at all) whole, escaped, `/` for a directory,
    a space otherwise; several extend to the exact-case common prefix and open a completion menu
    (shadcn `Command` with a controlled value, `shouldFilter={false}`, at most 200 rows) above
    the editor: Up/Down move, Enter or Tab picks (`applyCompletionItem` replaces the word,
    keeping its directory part). None shows "No matching commands" or "No matching paths".
  - The menu stays live while the human types, like fish and VS Code. It keeps its origin (the
    word's start, its scope and the full candidate list) and `followDraft` re-filters that list
    on every change of the word or caret, with no new `fs.list`; the selected row stays on the
    same item while it still matches, and matched characters are drawn in
    `.input-editor-menu-match` spans, so the option's accessible name stays the whole name. When
    the scope changes (`completionScope`: the word's directory part plus a leading `-`/`--`,
    e.g. a typed `/`), the candidates are listed again for the new scope and shown as they are:
    nothing is inserted, and one match is a one-row menu. A list with no matches hides the menu
    but keeps the origin, so Backspace back into a match shows it again. It closes for good on
    a space that ends the word, the caret leaving the word (a click, ←/→ past its start, Home,
    End), Escape, a pick, history, an accepted suggestion or vim normal mode. Focus stays in
    the textarea, which gets `aria-activedescendant` from the menu's selected option. Why not ask the shell: bash and zsh draw their completion menus in
    the terminal and edit their own line, which the editor would then have to read back off the
    screen (the RPROMPT problem in §6 of CLAUDE.md) and which conflicts with keeping the shell
    line empty.
  - `pty:commands` (main, `shellCommands.ts`) answers only the window attached to the pane. It
    reads the pane's `PINE_SHELL_STATE` file (`readShellState`: a regular file, not a symlink,
    at most 1 MiB; first line the shell's `$PATH`, then one line each for `VIRTUAL_ENV`,
    `CONDA_DEFAULT_ENV` and `KUBECONFIG` (newlines stripped, empty when unset), then its
    builtins, keywords, aliases and functions not starting with `_`), falling back to the spawn env's PATH, then lists the
    executables of every absolute PATH directory (`ExecutableIndex`: `readdir` + `stat` for
    the execute bit, names only, never file contents; relative entries such as `.` are
    skipped). Listings are cached per PATH string and reused until a directory's mtime
    changes (at most 16 PATHs). The shell writes the file in its prompt hook
    (`__pine_report_shell`), only when one of those lines changed. Why the shell reports
    at all: the spawn env misses whatever `.zshrc`/`.bashrc` add to PATH (`~/.local/bin`,
    cargo, pnpm) and every alias and function, so those would all look unknown. Why a file and
    not an OSC like the other marks: see §6 of CLAUDE.md.
  - Pine prompt (`terminal.prompt`, `shared/promptSettings.ts`, `lib/promptChips.ts`,
    `lib/usePromptChips.ts`, `components/PromptChips.tsx`, `PromptSection.tsx`), Warp's
    context-chip prompt. `style: 'shell'` (default) keeps the cwd line above; `'pine'` replaces
    it with an ordered row of chips (`chips`), or puts the row before the textarea on the input
    line when `sameLine` is on, followed by `separator` (`none`, `%`, `$`, `>`). A chip with no
    value is hidden, like Warp's. Core chips and their sources: `cwd` (the pane's OSC 7 cwd,
    `~`-abbreviated with main's home), `user`, `host` (main, `os.userInfo`, short hostname),
    `virtualenv` (folder name of `VIRTUAL_ENV`), `conda` (`CONDA_DEFAULT_ENV`), `node`, `kube`,
    `date`, `time12`, `time24` (a 15 s clock, only while one is in the list), `exitCode` and
    `duration` (the newest finished block). The default order is Warp's default without ssh,
    subshell and kube: conda, virtualenv, node, cwd, `git.branch`, `git.diff-stats`. Warp's
    branch, diff stats, ssh and subshell chips are not core; branch and diff stats are the
    built-in git extension's pane chips, listed by id only, so core imports no extension code
    and a disabled git extension just leaves them hidden (no value). Values from main come from `pty:prompt-context`
    (`main/promptContext.ts`), fetched when the editor shows and at every new prompt (A
    marker), answered only for the window attached to the pane. It reads the shell state file
    (above) and resolves `node` only when the cwd is inside a Node project (a `package.json` at
    or above it): the version is read off a versioned install path (nvm, fnm, volta), else the
    resolved binary is run once with `--version` (`execFile`, `shell: false`, 2 s timeout) and
    cached by real path and mtime. `kube` reads `current-context` from the first `$KUBECONFIG`
    file (as the shell reported it) or `~/.kube/config`, top-level key only, 1 MiB cap, cached
    by mtime; it isn't in the default list. Why main runs node and not the shell hook: a
    `node --version` in precmd costs every prompt tens of milliseconds, and the hook must stay
    cheap (§6 of CLAUDE.md). Clicking the `cwd` chip opens Files (which follows the pane cwd);
    right-click on the row offers Edit prompt, Copy prompt (chip texts and separator), Copy
    working directory and Show in Files. Edit prompt opens Settings → Prompt
    (`openSettings('prompt', paneId)`; the Terminal page links there too), an ordinary Settings
    page, not a dialog: the style select, a live preview from that pane's real values (else the
    active terminal; `promptPreviewPaneId` in `uiStore`; chips without one are drawn dashed as
    "no value here"), the ordered list (drag, the arrow buttons, or Alt+↑/↓ on a row's handle,
    announced through a live region), the available chips, the same-line switch, the separator
    and Restore default chips. Every change is written at once through `setTerminal`
    (`parsePromptSettings`), like every other setting; the chip editor stays usable under the
    shell prompt and says it applies to the Pine prompt.
    Extension chips are the pane chips of the extension API (`contributes.paneChips`,
    `ext.setPaneChip`): the id `<extId>.<chip>` sits in the same ordered list, Settings → Prompt lists
    every enabled extension's chips from `usePaneChipCatalog()`, and the row reads the pane's
    values from `usePaneChips(paneId)` (`lib/paneChips.ts`, over `extensionsStore.chips`),
    the same source as the pane-header badges. Tones `neutral` and `brand` draw as the default
    chip. A click goes through `runPaneChip`: focus the pane, then run `<extId>.<command>`, so
    the extension sees the pane as its caller. Why one source: a second prompt-only store would
    need its own feed and drift from the header.
    Plain shell prompt: when the Pine prompt is on in editor mode, `pty:attach` gets
    `pinePrompt` (`{separator, sameLine}`) and main starts zsh/bash with `PINE_PROMPT=pine`,
    `PINE_PROMPT_SEPARATOR` and `PINE_PROMPT_LINES` (see Shell integration). Why: the chips already show the context,
    and a framework prompt left in scrollback (right prompts, clocks, multi-line frames) is
    noise above every block. It is decided at spawn, so terminals already open keep their
    prompt until a new shell starts (the settings text says so).
  - Syntax highlighting: `lib/shellTokens.ts` `tokenizeShell` splits the draft into tokens
    that cover every character (command, argument, flag, string, variable, assignment,
    operator, comment, space); a command token is colored as unknown (the palette's red) when
    the command list is loaded, the name has no `/` and it isn't in the list. Colors are the
    terminal palette's ANSI colors, passed in as `--syn-*` custom properties, so the draft
    matches the theme of the terminal above it. Rendering: the textarea stays the editor (its
    text is transparent, its caret and selection are real) and a `pre-wrap` overlay
    (`.input-editor-highlight`, `pointer-events: none`) with the same font, padding, border
    width, line height and scrollbar gutter draws the colored tokens and the ghost suggestion
    on top; it follows the textarea's `scrollTop`. While an IME composes, the textarea shows its
    own text and the overlay hides. Why this and not contenteditable or Monaco: a textarea keeps
    native IME, selection, undo, spellcheck-off and the existing tests for free; a
    contenteditable would need its own caret and selection mapping, and Monaco is far too
    heavy for one prompt line per pane.
  - Vim mode (`behavior.inputEditorVim`, off by default, `lib/vimMode.ts`): the editor starts
    in insert mode at every prompt; Escape enters normal mode (caret steps back one, shown as a
    block cursor drawn by the overlay, the native caret hidden). `parseVimKeys` reads counts,
    motions `h j k l w b e 0 $`, `x`, `u`, `D`, `C`, operators `d`/`c` with a motion or doubled
    (`dd`, `cc`) and a count on either side, and `i a A I o O`; pending keys show next to the
    NORMAL badge. `applyVimCommand` is pure. `cw` changes to the end of the word like vim;
    `dw` stops at the line end. `u` restores the text from before the last edit (an insert
    session counts as one edit). `k` on the first line and `j` while walking history step
    through history. Enter submits from either mode; Escape in normal mode focuses the
    terminal. Why no library: vim emulations exist for CodeMirror and Monaco, not for a plain
    textarea, and the command set needed here is small enough to keep pure and tested.
  - Shells without integration never open a draft, so the editor never shows and the pane is
    a plain terminal.
  - Why: the editor changes the terminal host's height. The host is observed by the same
    `ResizeObserver` → 90 ms debounce → rAF → `syncSize` path as every other resize, and since
    the editor appears only at an idle prompt, that shrink takes the prompt-aware atomic resize
    (§6 of CLAUDE.md). A quick command hides and shows it inside one debounce window, so the pty
    usually isn't resized at all. `e2e/input-editor.spec.ts` checks the prompt isn't duplicated.
- **File links** (`lib/fileLinks.ts`, `lib/terminalFileLinks.ts`): an xterm link provider finds
  paths in output (`src/a.ts:12:4`, `Program.cs(12,5)`, `File "x.py", line 8`, `~/…`, bare
  `name.ext`), resolves them against the pane's OSC 7 cwd, and underlines only those `fs:stat`
  reports as files (cached 5 s). Ctrl+click (⌘ on macOS) calls `openFileAt`, which queues the
  position in `editorRevealStore`; the editor takes it once the model is set. Wrapped rows are
  joined and every character keeps its cell, so wide characters and wrapping map back exactly.
  Why stat first: a link that opens nothing is worse than no link. Why no pointer cursor: the
  app keeps the arrow everywhere (DESIGN §5).
- **Long-command notification**: when a command runs ≥ 10 s (`NOTIFY_AFTER_MS`) while the window
  is unfocused, the pane is marked `done` (or `error`) unread and the renderer posts it to main's
  notification log with a desktop notification. The command text comes from the buffer line at
  mark B, starting at the cursor column recorded at B.
- **Notification escapes**: OSC 9 (`9;message`), OSC 777 (`777;notify;title;body`) and OSC 99
  (kitty; `p=title|body`, `i=` chunk id, `d=0` continuation, `e=1` base64) mark the pane `waiting`
  unread and go to the log; a desktop notification fires only if the window is unfocused or the
  pane isn't visible. BEL in a pane that isn't being viewed marks it unread. The parsers are pure
  (`lib/attention.ts`). Why OSC 9 ignores `9;1` to `9;12`: those are ConEmu subcommands (`9;4` is
  the progress bar several CLIs emit), not notifications.
- **Replay is silent**: attention signals are suppressed while the attach replay buffer is being
  parsed (`replaying`, cleared in `term.write`'s callback). Why: the replay is history. Without
  this, every remount or restore would re-raise every old notification and failed command.
- **Terminal state bridge** (`commands/terminalStateBridge.ts`): a read-only listener on
  `blocksStore` + `layoutStore` that pushes `{cwd, running, blockCount, lastExitCode, generation}`
  per pane, debounced 100 ms. cwd is watched in `layoutStore` because an OSC 7 change doesn't
  touch `blocksStore`.
  - Main keeps the snapshot only if its `generation` is ≥ the cached one.
  - Main emits `pane.state` only when a field actually changed.
- **Terminal colors** (`lib/colorScheme.ts`): xterm draws to canvas and can't read CSS
  variables, so the terminal gets a color scheme object (`plugins/colorSchemes.ts`) as its
  `ITheme`. `useScheme('terminal')` resolves `terminal.theme`: `"match"` (default) uses the
  scheme the effective Pine theme names (`Theme.colorScheme`; a theme naming an unknown scheme
  gets the first scheme of its appearance), any other id that scheme (an unknown id falls back
  to the linked one). A linked scheme with a custom accent takes the accent's brand color as its
  cursor (`accentScheme`). The result is memoized, so `Terminal.tsx` resets `term.options.theme`
  only when the scheme really changes. Why a separate axis instead of one palette per theme:
  people keep a favorite terminal scheme (Catppuccin, Gruvbox) under any app chrome, and a plugin
  theme no longer has to ship a palette to get a terminal of the right lightness.

## 5. Renderer model

### Workspaces, layout, surfaces

- **Workspace** (`stores/workspacesStore.ts`) → **split tree** (`layout/tree.ts`, pure; `stores/layoutStore.ts`)
  → **Pane** → one **Surface**: `terminal | editor | browser | extension | diff`.
  - An `editor` pane is a file view (`components/FileView.tsx`): images (`png jpg jpeg gif webp
    svg bmp ico avif`) open in `ImageViewer`, `.pdf` in `PdfViewer`, anything else in Monaco
    (`lib/fileKinds.ts`). Why not new surface kinds: a file view is still "the file this pane
    shows", so `openFile`, restore, tabs, the Files panel and the pane title stay one code path;
    switching the file swaps the viewer (keyed by path).
  - Where `openFile` puts a file follows `editor.openFilesIn`. `tab` (default): focus an editor
    already showing that path, else reuse an editor tab in the focused pane's slot
    (`slotPaneOfKind`), else add a tab to that slot. `split`: reuse the workspace's first editor
    pane, else split the focused pane to the right.
  - An `extension` pane carries `extensionId` and renders that extension's panel
    (`ExtensionPanelView`, §11). `openExtensionPanel` reuses the workspace's existing panel of the
    same extension.
  - A `diff` pane (`DiffView`, §9) is opened by an extension's `ext.openDiff`. `openDiff` reuses
    the workspace's diff pane. The pane node holds only the title and a `cwd` (the file's
    directory); the two texts live in `stores/diffStore.ts` keyed by pane id, dropped by
    SurfacePool when the pane goes away. Why not in the node: the layout is autosaved to
    `workspaces.json` and a diff can be megabytes.
  - The `agent` kind exists but has no surface (it shows a ghost title).
  - Zoom renders only `zoomedPaneId`.
  - Closing the zoomed pane clears the zoom.
- **Workspace rows** (`components/DeckRail.tsx` `WorkspaceRow`, `lib/workspaceOrder.ts`,
  `lib/workspaceGroups.ts`): cmux-style
  rows. Title is the user's name or the folder; under it the latest message that still needs
  you (or the running program's title), then an optional description, then path and extension
  items. `pine workspace describe` (→ `workspace.describe`, drive-self, caller's workspace) or the
  row menu sets the description; it renders Markdown restricted to links, emphasis and code, as a
  sibling of the row button so links are real links (a link inside a button is invalid and would
  select the row). The row menu renames, edits the description, pins, moves, marks read, groups
  and closes others; rows drag to reorder. Pinned workspaces stay contiguous at the top.
  `Ctrl/⌘+1..9` runs `workspace.goto` with the digit's index (`lib/useModifierHint.ts` shows the
  digits); a member of a collapsed group keeps its digit but shows no hint.
- **Workspace groups** (`lib/workspaceGroups.ts`, pure; `workspacesStore` `groups`): a group is
  `{id: g<n>, name, color?, collapsed?}`, and a workspace joins one through `groupId`. There is no
  member list: the flat `workspaces` array stays the only order, and `normalizeGroups` keeps each
  group's members contiguous (gathered at the first member), orders `groups` as they appear, and
  drops a group that has no members left. The sidebar renders `toBlocks()`: a header per group
  (caret, color swatch, name, member count, the members' aggregated state dot and summed unread
  badge, shown even when collapsed) with its members indented, and a plain row per ungrouped
  workspace. Why a flat array and not nested lists: `Ctrl+1..9`, `workspace.goto`, the palette,
  `workspace.list` and the gateway's `session.list` all read one ordered list, and every existing
  reorder, close and restore path keeps working on it.
  - Pinned and grouped are exclusive: pinning takes a workspace out of its group, and joining a
    group unpins it. Why: pinned rows are one block at the top and a group is one block, so a
    member can't be in both.
  - Moves (`moveWorkspaceBy`): a member moves only inside its group; an ungrouped workspace steps
    over a whole group block. Drops (`applyDrop`, one drag state in `WorkspacesView`): a workspace
    dropped next to a row takes that row's group (none for an ungrouped row), on the lower half of
    a group header it becomes the first member, on the upper half it lands above the group
    ungrouped, and in the space below the list it goes to the end ungrouped. A dragged group
    header moves the whole block before or after the target's block.
  - New workspaces (`addWorkspace`): the first `workspaceGroups.byCwd` rule whose glob matches
    the workDir puts it in that group (created by name if missing, at the group's end). Otherwise,
    when the active workspace is in a group, the new one joins it right after the active one.
    Otherwise it is appended ungrouped. Globs (picomatch, `dot: true`, like the file tree): `*`
    within one path segment, `**` across, `?` one character, matched against the whole workDir
    (trailing slashes ignored), so a workspace opened at `~` matches only a pattern that covers
    the literal `~`.
  - Group ids come from their own counter and are adopted on restore (`adoptGroupIds`), like
    workspace ids.
  - Commands: `workspace.newGroup`, `workspace.ungroup`, `workspace.toggleGroup`,
    `workspace.deleteGroup` act on the command target's workspace; `workspace.group {name}`
    (hidden, drive-self) joins or creates the named group; `workspace.groups` (hidden, read-board)
    lists them. The CLI's `pine workspace group|ungroup|list` use these (§6).
- **Markdown preview** (`components/MarkdownPreview.tsx`, `typeset.css`): `.md` editors get a
  Preview toggle that renders the live model text with react-markdown + remark-gfm inside a
  `typeset typeset-pine` container. `typeset.css` is shadcn Typeset, copied in (comments stripped)
  and owned here. Why not streamdown: it puts Tailwind classes on every element, which beat
  Typeset's `:where()` styles. Raw HTML is never rendered, and links open with `target="_blank"`,
  which the window's open handler routes to `openExternalSafe`.
- **Tabs** (`layout/tree.ts` `TabsNode`, `components/Pane.tsx`): a split-tree leaf is a pane or a
  `tabs` stack of panes with one shown (`activeId`). The pane header is a tab strip (one tab for
  a lone pane) with new terminal tab, new browser tab and split buttons; a tab's pane id is still
  the identity for its pty, attention and surface.
  - Extension pane chips (`components/PaneChips.tsx`) sit between the attention message and the
    Resume button as outline badges tinted by tone; a chip with a command is a button that
    focuses the pane and runs `<extId>.<command>` from the palette registry, so the extension's
    caller context names that pane. Other views read chips through `lib/paneChips.ts`:
    `usePaneChips(paneId)` returns the pane's chips in catalog order with their titles, and
    `usePaneChipCatalog()` lists every chip enabled extensions contribute
    (`{extId, extName, id, title}`), both pure over `extensionsStore` (`chipsForPane`,
    `paneChipCatalog`). Why a catalog: a view that lays chips out itself (a Warp-style prompt)
    must know which chips exist before any has a value.
  - Splits (`insertBeside`) and edge drops target the tab stack's slot, not the pane inside it;
    a center drop moves the pane into the target's tabs (`addTab`). Why: splitting inside a tab
    would nest layouts in a tab, which nobody can see or navigate.
  - Closing a tab shows the next one; one tab left unwraps to a plain pane. The layout store
    focuses the neighbouring tab (`successorOf`), not the tree's first pane.
  - `patch` runs `selectTab` for the active pane after every change, so focusing, revealing an
    unread pane, opening a file or `pine` targeting a pane always brings its tab forward.
  - Every tab's body stays mounted in its slot; a background one is `visibility: hidden` and
    `inert` (set in a layout effect, React 18 has no `inert` prop). Why: parking a host detaches
    it, and a detached `<webview>` reloads. `isPaneVisible` is false for a background tab, so a
    signal there rings instead of being marked seen.
- **Agent resume** (`shared/agentResume.ts`, `main/paneResume.ts`): `pine resume-token` →
  `pane.setResume` (drive-self, own pane) → `resume.set` stores `{agent, id}` on the pane node,
  which autosaves with the layout. The header's Resume button and `agent.resume`
  (Ctrl+Shift+R / ⌘⇧R) type `resumeCommand` at an idle prompt through `insertCommand`. Why a
  structured token and not a command string: the hook payload comes from the agent, and a stored
  command would be typed into a shell later.
- **Agent hibernation** (`lib/hibernation.ts` pure policy, `lib/hibernationScheduler.ts`,
  `components/HibernatedView.tsx`; settings `agents.hibernation.{enabled, idleSeconds,
  maxLiveTerminals}`, off by default). Every 5 s, when enabled: a terminal pane counts as a live
  agent only if it has a resume token and its running block's command starts that agent
  (`commandAgent`: program basename, after env assignments/`exec`/`env`). When more live agents
  exist than `maxLiveTerminals`, the longest-idle ones that are not visible (`isPaneVisible`)
  and have had no pty output or input (`lib/paneActivity.ts`, fed by `Terminal.tsx`) for
  `idleSeconds` are hibernated until the count fits: `pty.hibernate` in main, then the pane node
  gets `hibernated: true`, SurfacePool renders `HibernatedView` instead of `TerminalView` (the
  xterm and its blocks are disposed) and the tab shows a moon. Resume (the view's button, the
  header button, or `agent.resume`) clears the flag, which mounts a fresh `TerminalView` whose
  attach spawns a new shell at the pane's last cwd with the stashed scrollback, and
  `runWhenIdle` types `resumeCommand` once that shell shows its first prompt. `hibernated` is
  never persisted (`fromPane` strips it): after a restart every shell is fresh anyway.
  Trade-offs: the whole shell is killed, so background jobs, an unsaved agent turn and anything
  the agent had running in that pane end; resume depends on the agent's own session store; a
  shell without integration has no running block and is never hibernated; an agent that is
  thinking silently for longer than `idleSeconds` looks idle; wake is never automatic (revealing
  the pane shows the hibernated state), because typing the resume command is a human decision
  (CLAUDE.md §4).
- **Surface persistence** (`components/SurfacePool.tsx`, `stores/surfaceSlotsStore.ts`):
  - SurfacePool portals every pane's surface, across all workspaces, into a persistent,
    absolutely-positioned host div created in a detached parking holder.
  - `Pane` has a callback ref that calls `mountSurface`, which moves the host into the pane's slot.
    `parkSurface` moves it back, but only if that slot still owns it.
  - `releaseSurfaces` drops hosts for pane ids that no longer exist.
  - Why: the portal target never changes, so split, move and zoom only move DOM nodes. xterm,
    Monaco and webview state survive, and ptys are not re-attached.
- **Split rendering** (`PaneTree.tsx`): Allotment keyed by the child-id list, mounted from the
  node's `sizes` (`defaultSizes`, scaled to the container). Why: Allotment caches sizes, so a
  structural change must rebuild it or panes collapse to a sliver; a pure resize keeps the
  instance. Mounting from `sizes` is what lets a rebuilt, restored or newly sized split keep the
  proportions the store holds instead of falling back to an even split.
- **Remembered panel size** (`layout/panelSize.ts`, `lib/panelSizes.ts`): when the human finishes
  dragging a splitter (Allotment `onDragEnd`), every direct pane child of that split that is a
  panel (`panelKey`: `extension:<id>`, `view:<name>`, `chat`) has its share of the split stored,
  clamped to 0.15–0.85. `openSingleton` (extension panels, views, the chat pane) gives a newly
  created panel that share with the pure `sizePanel`, taking the room from the pane it split from
  (never more than 85% of the two), after `equalizeOnSplit` so the human's size wins. An already
  open panel is only focused. Why localStorage (key `panelSizes`, writes debounced 300 ms, read
  fresh on every open): it is UI state, not a setting, so it stays out of `settings.json` and
  settings sync; every Pine window loads the same `file://` origin in the default session, so
  one synchronous store already serves all windows and survives restarts without a new IPC
  method or main-side file. Hand-edited values are clamped or dropped on read.
- **No workspaces** (`workspacesStore.ts`, `WorkZone.tsx`): zero workspaces is a valid state. The store
  starts empty (`activeWorkspaceId: null`); only the user (`workspace.new`, the sidebar or empty-state
  button, Ctrl+Shift+T / ⌘T, opening a file with no workspace via `lib/openFile.ts`) or restore
  creates one, and closing the last workspace leaves none. The work zone then shows the empty
  state. With no active workspace, pane commands are no-ops, `pane.list`/`workspace.list` return
  `[]`, extension panels and diffs are not opened, and `workspace-activated` is not emitted. Why:
  a terminal the user didn't ask for is noise, and re-seeding one on close made the last
  workspace impossible to get rid of.
- **New workspace placement and folder** (`lib/newWorkspace.ts`, Settings → Workspaces): every
  user path that creates a workspace (button, `workspace.new`, chord, empty state, opening a file
  with none open) calls `startNewWorkspace()`, which reads `workspaces.placement`
  (`end` | `top` | `afterCurrent`, resolved by `insertIndex` in `lib/workspaceOrder.ts`, never
  above the pinned group) and picks the `workDir`: the active workspace's focused pane `cwd` when
  `workspaces.inheritFolder` is on and the pane has one, else `workspaces.defaultFolder` (`~`).
  The `workDir` stays the anchor; only its initial value is inherited.
- **Notification center** (`NotificationCenter.tsx`, `lib/notificationGroups.ts`): each log entry
  has a `kind` (`waiting`, `approval`, `done`, `error`, `message`) set by whoever posts it
  (agent state, approval requests, long or failed commands, OSC notifications; extensions and
  `pine notify` post `message`; old entries read as `message`). Text tabs filter: All, Needs you
  (waiting, approval, error, with a count including pending approvals), Finished, Messages.
  Entries are grouped by workspace (extension entries by extension, closed panes together),
  groups ordered by their newest entry. The top-bar trigger is a tray icon with a filled
  `--attn` count badge.
- **Tab and file conveniences**: a middle-click on a pane tab runs `pane.close` (the same guard as
  its X); the close guard (`lib/closeConfirm.ts`) asks for a pane, workspace or quit when it has
  a running command or an editor file with unsaved changes (`useEditorStatus.dirty`), listing
  both. Tree rows are draggable with the path as `application/x-pine-path`; a terminal surface
  accepts that or OS files (`window.pine.files.pathForFile` → `webUtils.getPathForFile`) and
  pastes the shell-quoted paths plus a space through `pasteRef` (risky-paste check skipped, no
  Enter). The file menu's "Open in new workspace" starts a workspace at the folder (or the
  file's folder, then opens the file).
- **Workspace names follow the project** (`lib/workspaceProjects.ts`, `main/projectRoot.ts`): for
  each workspace, the active pane's cwd goes to `workspace:project`, which returns the nearest
  folder below home that has a `.git` (never home itself), else the folder, as `{name,
  display, dir}`; `setProject` stores it as the automatic `name`, `projectDir` (the rail's
  path line, saved in the snapshot) and `workDir`, so new terminals open in the project.
  `customName` (Rename) always wins. A workspace with no panes is skipped, so closing every tab
  keeps its last project instead of falling back to `~`. Why: a
  workspace created at `~` and then used in a repo was stuck being called "home".
- **Close confirmation** (`lib/closeConfirm.ts`, `CloseConfirmDialog.tsx`, `closeConfirmStore`):
  a command is running when `blocksStore.running` has a block for a pane of the workspace.
  Closing a workspace (row X, context menu, `workspace.closeOthers`) and closing any pane or tab
  whose own command is running (`pane.close`, the tab's X) go through `requestClose*`, which
  awaits a shadcn Dialog naming the workspaces and their commands when `workspaces.confirmClose`
  is on. Closing an idle pane never asks, even when another pane of the workspace is busy.
  The base layer gives every element `border-color: var(--border)`, so a shadcn `border` without
  a color (the dialog footer's divider) uses the line token, not the text color; and
  `--destructive` maps to `--attn-fg` so destructive button text keeps 4.5:1 on dark surfaces. Quit
  uses the same dialog once for every window: main's `closeGuard.ts` asks each window for its
  running groups (`window:running` → `quitGroups`, gated by `workspaces.confirmQuit`), then shows
  them all in one dialog in the focused (else main) window (`window:confirm-close` →
  `confirmQuit(groups)`), and on approval sends `window:freeze` to every window. Why the answer
  comes from the renderers: only they know which commands run. Closing the main window quits;
  closing a detached window never asks about commands, because nothing stops (§2 Windows). In
  `main/index.ts` `before-quit` calls `preventDefault()` until the human approves; the approving
  pass sets `quitApproved` and calls `app.quit()` again, so the scrollback save and pty kill loop
  in `before-quit` run exactly once, after the human said yes. A loading or crashed window
  counts as having nothing running. E2E seeds
  `workspaces.confirmQuit: false` (`DOM_RENDERER_SETTINGS`) so `app.close()` never waits on a
  dialog; `e2e/workspace-settings.spec.ts` turns it on.
- **Close to tray** (`main/tray.ts`): with `workspaces.closeToTray` on (the default), or when Pine was started
  with `--hidden`, the main window's `close` handler hides it (`closeAction`) instead of asking
  `closeGuard`; a detached window never goes to the tray, it returns its workspaces to the main
  window (`broker.requestReturn`), and the manager workspace and its pane never move between
  windows (`isRestorable`, `canMovePane`). Also `AppTray` shows a tray icon only while Pine is hidden (Show, Quit). Main
  reads the setting from `settings.json` at close time (`readCloseToTray`), so it always follows
  the file. Quit shows the window before `app.quit()`, because `closeGuard` asks through the
  renderer and a dialog in a hidden window can't be answered. Why the tray labels live in main
  (`trayLabels`) rather than `i18n/dict.ts`: main can't import the renderer's dictionary. Only
  the packaged app takes a single-instance lock (`app.isPackaged`); a second launch reveals the
  running Pine (`second-instance`, skipped for `--hidden`). Why only packaged: `pnpm dev` and the
  installed app share one `userData`, so a lock there would stop the dev build from starting while
  the installed Pine runs. Why a palette Quit (`app.quit`, needs `destructive`): with close-to-tray
  on by default, closing the window no longer quits and the tray icon exists only while hidden. `e2e/tray.spec.ts`
  hides the window with a command running and checks its output after showing it again.
- **Wrapped titles**: `workspaces.wrapTitles` adds `.tab-title.wrap` (2-line clamp) to sidebar rows.
- **Hidden workspaces** (`WorkZone.tsx`): each workspace mounts on first visit and stays mounted.
  Inactive ones get `visibility: hidden` + `inert`.
  - Why `visibility`, not `display: none`: the box keeps its size, so the fit stays valid.
  - `inert` is cleared in a layout effect so focus can move back into a terminal (focus cannot
    land in an inert subtree).
- **Pane activation** (`Pane.tsx`): native `mousedown` (capture) and `focusin` listeners on the
  pane frame run `pane.focus`. Why native: surfaces are portaled from `SurfacePool`, so React
  synthetic events from inside a terminal bubble to SurfacePool, not to the `Pane`; a React
  `onMouseDownCapture` only ever saw clicks on the header.
- **Pane drag/drop** (`Pane.tsx`): the header is the drag handle and uses the MIME type
  `application/x-pine-pane`, so file and text drags are ignored. Dropping within 25% of an edge
  re-splits on that side; the center swaps the two panes.

### Live workspace state and attention

Each pane has an attention record (`stores/attentionStore.ts`): `state`
(`none | working | waiting | done | error`), an `unread` flag, the latest `message`, and the time
it last changed. All transitions go through the pure reducer `reduceAttention` in
`lib/attention.ts`:

| Event | Source | Effect |
|---|---|---|
| `set` | `pine state` (`pane.setAttention` → `attention.set` command) | set the state; `waiting`/`done`/`error` mark unread; `none` clears everything |
| `notify` | OSC 9/99/777 (`waiting: true`), `pine notify` (`waiting: false`) | unread + message; terminal escapes also set `waiting` |
| `bell` | BEL in an unviewed pane | unread only |
| `commandStart` | OSC 133 C | drops a stale agent state to `none`, keeps unread |
| `commandEnd` | OSC 133 D while the pane isn't viewed | non-zero exit → `error` unread; ≥ 10 s with the window unfocused → `done` unread |
| `input` | keystrokes into the pane | `waiting` → `none` |
| `view` | the pane is being looked at | clears unread; `done` → `none` |

A pane is *viewed* when the window has focus, its workspace is active, settings aren't covering
it, no other pane is zoomed over it, and it is the workspace's active pane (`isPaneViewed`).
`signalPane` dispatches an event and then a `view` if the pane is viewed, so a signal to the pane
you're looking at never rings. `startAttentionSync` (started in `main.tsx`) re-applies `view`
when the active workspace, active pane, settings overlay or window focus changes, prunes records
of closed panes, and recomputes every workspace's state whenever attention, running blocks or
layouts change.

Workspace state is the highest-ranked pane state, `waiting > error > done > working > idle`. A
pane's state is its attention state, or `working`/`idle` from its running block when attention
is `none` (`paneLiveState`, `aggregateWorkspaceState`). Why attention wins over the running block:
an agent CLI is itself a running command for its whole life, so "running" alone would show every
agent pane as busy even while it waits on you. Each change emits a `workspace-state` lifecycle
event; main raises `agent.needs-input` for `waiting` and `agent.done` for `done` for the gateway.

**Jump to latest unread** (`attention.jumpToLatest`, Ctrl+Shift+U / ⌘⇧U) picks the unread pane
with the newest change across all workspaces (`latestUnread`) and reveals it (`revealPane`): leaves
settings, switches workspace, un-zooms if another pane is zoomed, focuses the pane, marks it
viewed, and focuses its xterm on the next frame (`focusSurface`). Why the next frame: the
workspace's layer is still `inert` until its layout effect runs, and focus can't land in an inert
subtree.

**Notification center** (`components/NotificationCenter.tsx`, the bell in the top bar): the badge
is the number of unread panes (the same outlined attention pill as the sidebar's unread badge); the popover lists main's notification log newest first (workspace ·
pane, message, time), reloads on `notifications:changed`, and each entry reveals its pane
(entries whose pane is gone are disabled). "Clear all" empties the log and marks every pane read.
The log (`main/notify.ts`, `notifications.json`, capped at 500) holds `pine notify` calls and the
renderer's posts (terminal escapes, long commands). Clicking a desktop notification restores and
focuses the window and sends `notifications:activate` with the pane id, which reveals it.
**Desktop banner policy** (`shared/notificationSettings.ts`, settings key `notifications`): every
event is logged; whether it also raises a system banner is split in two. The renderer decides per
event with `wantsDesktopBanner(settings, kind, seen)`: the kind (`agentWaiting`, `agentDone`,
`commandFinished`; a plain `message` is always eligible) must be on, and a pane you are looking at
(`isPaneViewed`) is skipped unless `whenFocused`. Agent banners come from `attention.set` with
`waiting`/`done` (`lib/agentNotification.ts`); `pine notify` asks the renderer through the
`attention.notify` result (`{ desktop }`). Main then applies the master switch and sound
(`desktop`, `sound` → `silent`) by reading `settings.json` at show time, so extension panel
notifications obey them too. Why split: only the renderer knows what is on screen; only main
creates the `Notification`.
Why the log lives in main: `pine notify` arrives there without a renderer round-trip, the gateway
listens to the same `notify` event, and the log survives restarts.

**Control plane**: `pane.setAttention {state, message?, paneId?}` (`main/attention.ts`, cap
`drive-self`) acts on the caller's own pane; a `paneId` (external id) of another pane needs
`all-workspaces`. Main forwards it as the renderer command `attention.set` targeted at that pane.
The renderer commands `attention.set` and `attention.notify` act only on `ctx.activePaneId` (the
command target), never on a pane id from args. Why: `command.exec` checks the caller's
capabilities against the target, not against ids inside args, so an args pane id would let any
pane bypass `all-workspaces`. Agent hook recipes: `docs/AGENT-HOOKS.md`.

### Commands and chords

- **Registry** (`commands/registry.ts`): every action is a named command with arg schema.
  `describe()` backs `pine commands --json`. `execWith` never throws; it returns a `CommandResult`.
  Built-ins (`commands/builtins.ts`): `pane.*` (split/close/focus/zoom/move/list), `workspace.new/list/save`,
  `palette.toggle`, `view.toggleRail`, `app.openSettings`, `attention.set/notify/jumpToLatest`,
  `block.selectPrev/selectNext/copyCommand/copyOutput/copyBoth/rerun`, `history.search/insert`,
  `workflows.search`,
  `editor.open`, `browser.new/open`, `settings.get/set`.
- Extension palette commands (`<extId>.<command>`, e.g. `git.show`) are registered and
  unregistered at runtime by `commands/extensionBridge.ts` as extensions are enabled/disabled.
  The registry notifies subscribers; the palette re-renders and the bridge re-publishes the
  descriptor list to main. An extension command never replaces a core command with the same id.
- The renderer doesn't check capabilities; the socket and gateway do.
- There is deliberately no `workspace.restore`. Restoring into a live window would tear down every
  attached pty; restore happens only at boot.
- **Chords** (`lib/chords.ts`): macOS uses Cmd+K (palette), Cmd+\ (sidebar), Cmd+, (settings),
  Cmd+Shift+U (jump to latest unread), Cmd+Shift+H (command history), Cmd+T (new workspace),
  Cmd+Shift+E / Ctrl+Shift+E (send a file view's selection to an agent; Why E: Monaco already
  binds Ctrl+Shift+A, C, G, I, K, L, M, O, R and Z), Cmd+Shift+S / Ctrl+Shift+S (search saved
  workflows; Why not Warp's Ctrl+Shift+R: that is agent resume here, and S is free in Monaco),
  Cmd+↑/↓ (previous/next block) and native Cmd+C/V/F. Other platforms use Ctrl+Shift+P,
  Ctrl+Shift+B, Ctrl+, Ctrl+Shift+U, Ctrl+Shift+H, Ctrl+Shift+S, Ctrl+Shift+T, Ctrl+Shift+↑/↓ and
  Ctrl+Shift+C/V/F (copy/paste/find). Plain Ctrl+T stays with the shell (readline transpose). On Linux some IBus
  setups claim Ctrl+Shift+U for Unicode entry before the app sees it; the palette's "Jump to
  Latest Unread" and the bell still work there.
  - The defaults above are `DEFAULT_CHORDS`, one canonical chord string per platform. The
    user's `keybindings` setting (command id → chord string, or `null` to unbind) overrides
    them; `effectiveBindings(user, mac)` merges the two into an id → chord map plus a
    signature → id index, and `currentBindings` caches it per settings object, so every reader
    (`matchChord`, `isAppChord`, `chordLabel`/`useChordLabel`, the terminal key handler,
    palette hints, the modifier-hold digit hints) sees a change at once. Any visible palette
    command can be bound, not only the ones with a default (`bindableIds`); a bound command
    that isn't a terminal chord is an app chord and runs through the window listener.
  - Chord grammar and the guard live in `lib/chordSpec.ts`: `parseChord` (aliases, `Mod` =
    Cmd on macOS / Ctrl elsewhere, `1-9` for the workspace jump), `formatChord` (canonical
    string), `chordText` (label), `specFromEvent` (letters from `key`, other keys from `code`
    so Shift+digit and Shift+punctuation still match), `stealsTerminalKey`, `usedByMonaco`.
    Why the guard: Escape, Tab, keys without Ctrl/Cmd, plain Ctrl keys other than digits,
    `, . ; ' =` and F-keys, and plain/Ctrl arrows reach the shell (readline, signals, TUIs);
    on macOS only ⌘ chords are safe because Control and Option chords go to the shell. An
    override that fails the guard on this platform (for example a Ctrl chord synced from Linux
    to a Mac) is kept in `settings.json` but ignored, and Settings → Keyboard says why.
  - Settings → Keyboard (`KeyboardSection.tsx`) records a chord from the next non-modifier
    keydown (captured on `window` in the capture phase, so neither app chords nor the
    settings Escape handler see it; a bare Escape cancels). A refused chord shows an inline
    error and keeps recording; a chord another command holds (or a digit inside the
    workspace jump's 1-9) asks to Replace, which unbinds the other; a known Monaco default
    asks to confirm, because Monaco keeps that key while an editor has focus.
  - `pine settings set keybindings.<id> <chord>` (or the whole `keybindings` object) goes
    through `setKeybindingSetting`, which applies the same guard and refuses with a reason.
    Keybindings are not a grant, so agents may change them.
  - App.tsx has a window keydown listener that runs app chords.
  - Inside the terminal, xterm's key handler returns false for app chords so they reach the
    window listener.
  - On non-mac platforms the terminal handles copy, paste and find itself. Block navigation is
    terminal-local on every platform.

### Settings and plugins

- `stores/settingsStore.ts` persists `userData/settings.json` (debounced 300 ms): `locale`,
  `appearance` (theme + ui/terminal/editor fonts), `behavior` (`cursorStyle`,
  `cursorBlink`, `restoreWorkspace`), `files` (the Files tree, below), `workspaces` (`placement`, `inheritFolder`, `defaultFolder`,
  `confirmClose`, `confirmQuit`, `wrapTitles`), `terminal` (`scrollSpeed`, `scrollbackLines`,
  `warnOnRiskyPaste`, `minimumContrast`, `theme`), `panes` (`dimInactive`, `focusOnHover`,
  `equalizeOnSplit`, `hideTabClose`), `keybindings`, `capabilities.grants`, `sync.dir`.
  - `browser` and `editor` are their own groups, parsed by `shared/browserEditorSettings.ts`
    (invalid values fall back to defaults, zoom is clamped to 50 to 300).
  - `terminal.theme` and `editor.theme` go through `parseThemeChoice` (`shared/themeChoice.ts`):
    a trimmed scheme id up to 80 characters, else `"match"`. The id itself is checked against
    the catalog only when it is resolved, so a scheme a plugin adds later is not lost on load.
  - `keybindings` is validated on load by `parseKeybindings`: only string chords that parse
    and `null` survive. The platform guard is applied when the effective map is built.
  - `settings/terminalPaneSettings.ts` holds the pure parsing and clamping for the `terminal` and
    `panes` sections (numbers clamp, bad values fall back, non-booleans are dropped); `init` and
    `setByPath` both run it, so a hand-edited file or `pine settings set` can't store an
    out-of-range value.
  - `setByPath` (`applySetting`) rejects prototype-pollution segments, keys outside the data
    groups, keys that don't exist, and type changes, then runs the whole object through
    `parsePersisted` and refuses the change if the value didn't come out as written
    (`invalid value for <key>`), so an out-of-range number or unknown enum is an error rather
    than a silent clamp. Why refuse instead of coerce: an agent that is told "set 5" and
    silently gets 1000 believes the wrong thing; an error makes it look the key up
    (`pine settings schema <key>`). `previewSetting` (`--dry-run`) runs the same check without
    applying; `unsetByPath` sets the default. Results carry `previous` so an agent can undo.
  - `capabilities.grants` is changed only by hand-editing the file, and is read at startup.
  - `settings/settingsSchema.ts` holds the JSON Schema for that file (also served by `pine settings schema`); `settings/registerSettingsSchema.ts` registers it with Monaco.
- `plugins/builtin.ts` is a registry of built-in contributions only: themes (`adeberry`,
  `one-dark-vivid`, `instrument-night`, `dracula`, `oxocarbon`, `pine-light`, each naming its
  `colorScheme`), color schemes (`contributes.colorSchemes`, the 26 in `plugins/colorSchemes.ts`;
  catalog and sources in `docs/DESIGN.md` §3), LSP entries, locales (`en`, `zh-Hant`).
  These are data-only contributions; behavior and UI come from extensions (§11), listed in the
  same Settings → Plugins section.
- i18n: typed catalogs in `i18n/dict.ts`, read via `useDict()`.

### Files tree options and icon themes

- `settings/fileTreeSettings.ts` parses `files`: `exclude` (glob list, default `**/.git`,
  `**/.hg`, `**/.svn`, `**/.DS_Store`, `**/Thumbs.db`), `showExcluded`, `compactFolders`,
  `nesting` (`enabled` + `patterns`, VS Code's `explorer.fileNesting.patterns` syntax), `sortOrder`
  (`foldersFirst`/`mixed`), `sortBy` (`name`/`type`), `iconTheme` (`pine` or a contributed id).
  Settings → Files (`FilesSettingsSection.tsx`) and the Files header write the same keys.
  Why `exclude` replaced `behavior.showHiddenFiles`: two switches for "what the tree hides" would
  disagree; dotfiles are just the pattern `**/.*`, and the eye button is the one "show anyway".
- `lib/fileTree.ts` is the pure part of the tree: `excludeMatcher` (picomatch, `dot: true`)
  tests a row's absolute path and its path relative to the tree root, so `**/x` hides at any
  depth, a bare `dist` only at the root (VS Code's meaning), and "Hide in tree" can add an
  absolute path that keeps working as the tree root follows the terminal. `sortEntries`,
  `nestEntries` (one level deep: a file with children can't be nested and a nested file can't
  be a parent, so rules like `*.ts → ${capture}.js` plus `*.js → ${capture}.ts` can't cycle),
  and `compactChain`, which follows single-folder chains only when a folder is expanded, like
  VS Code. Why lazily: probing every visible folder's children on each listing would list whole
  trees (`node_modules`) the user never opens.
- Icon themes: `main/iconThemes.ts` loads a theme on `iconThemes:load` for an enabled
  extension's `contributes.iconThemes`, validates it (sizes, confinement after `realpath`, no
  symlinks, only image `iconPath`s, associations only to loaded definitions) and returns the icons
  as `data:` URLs, cached by the file's mtime and size. Why data URLs rather than a protocol:
  the renderer's CSP already allows `data:` images, nothing new is registered, and the renderer
  never names a file. `lib/iconTheme.ts` resolves an entry to a definition (VS Code's order; the
  `light`/`highContrast` section first, then the base), and `stores/iconThemeStore.ts` loads the
  chosen theme when its provider is enabled; otherwise the tree uses `fileIcon.ts`.

### Terminal and pane behavior settings

- **Risky paste** (`terminal.warnOnRiskyPaste`, `lib/pasteGate.ts`): two entry points, one per
  source. `planHumanPaste` is for the human's own clipboard: `Terminal.tsx` funnels the paste
  chord (`requestPaste`) and native `paste` events (a capturing listener on the host, which also
  sees the Linux middle-click paste: xterm moves its textarea under the pointer and the browser
  pastes the primary selection into it) through it. One line (after dropping one trailing
  `\r?\n`) is pasted with C0/C1 control characters and DEL stripped (tab kept) and never asks;
  two or more lines open `RiskyPasteDialog` while the setting is on, else are pasted with control
  characters stripped. Why strip instead of passing through: a raw ESC can end bracketed paste
  and let the rest run as typed keys; why drop the trailing newline: a copied line would
  otherwise run by itself. `confirmsGeneratedText` is for text Pine or an agent produced (chat
  Run in new terminal, `propose_command`): any newline or control character asks, whatever the
  setting, and its dialog has no Don't ask again. The dialog (shadcn Dialog,
  `min(90vw, 56rem)` wide) previews through `pastePreview` (control characters as `^[`-style
  tokens, `\xNN` for C1), shows the line and character count, and focuses Paste so Enter pastes;
  Escape and Cancel drop it. Don't ask again sets `warnOnRiskyPaste: false` on Paste. The setting
  is human-only: `settings.set`/`settings.unset` refuse it like `behavior.externalEditor`
  (`PROGRAM_SETTINGS`), so an agent can't switch the check off. Why intercept in the capture
  phase and stop the event: xterm's own textarea handler would otherwise paste before the dialog
  could answer. Programmatic pastes (`insertCommand`, report references) are not gated; they
  already have their own idle-prompt rules.
- **Scrollback, wheel speed, contrast** are xterm options (`scrollback`, `scrollSensitivity`,
  `minimumContrastRatio`), set at construction and updated on change.
- **Dim / hover focus / tab close** (`panes.*`): `Pane.tsx` adds `.dimmed` only when `dimInactive`,
  hides the tab close button when `hideTabClose`, and with `focusOnHover` arms a 150 ms timer on
  `mouseenter` that runs `pane.focus` and then `focusSurface`. `lib/hoverFocus.ts` `canFocusOnHover`
  vetoes it while a text field (not xterm's or Monaco's own input) has focus or a dialog, menu,
  listbox or the palette is open; a pressed mouse button or a `mousedown` cancels it.
- **Equalize on split** (`panes.equalizeOnSplit`): `patch` in `layoutStore` sees a layout whose slot
  count grew (`slotCount`; adding a tab does not count) and applies `equalizeSizes` (pure) to every
  split. Why an epoch (`WorkspaceLayout.equalized`, part of the Allotment key in `PaneTree`): Allotment
  reads `SplitNode.sizes` only when it mounts, so only a remount makes it lay out equally.

### Settings sync

`sync.dir` in `settings.json` names a folder the user owns (a repository they commit, a
Syncthing or Dropbox folder). Settings → Sync (`SyncSection.tsx`) sets it through a folder picker
(`dialog:pick-folder`) and the store writes it at once (`setSyncDir`); `sync` is not one of the
store's `DATA_KEYS`, so `pine settings set` can't change it.

Main (`settingsSync.ts`) syncs two files: `settings.json` without its local-only keys (`sync`,
`capabilities`) and `extensions.json`. For each, `planSync` compares a hash of the local and the
folder copy against the hash recorded at the last sync (`sync-state.json`): only one side
changed → copy it over; both changed (or a first sync with two different copies) → the newer
mtime wins and the other side's content is written next to it as
`<name>.conflict-<time>-<host>.json`, which Settings → Sync names. Pulling `settings.json` keeps
the local-only keys of the local file and ignores those in the folder copy. Invalid JSON on either
side stops that file (nothing is overwritten) and shows an error. Changing `sync.dir` starts
over (no recorded hashes).

It runs at startup before the extension host reads `extensions.json`, when a window gains focus
(throttled to once per 2 s), and 800 ms after `settings.json` or `extensions.json` changes on
disk (an `fs.watch` on `userData`, which also catches the renderer's own saves). A pulled
`settings.json` sends `settings:changed`, and the renderer re-runs `init()`; a pulled
`extensions.json` reloads `ExtensionStore` and `ExtensionHost.reloadRecords()` starts or stops
processes to match.

Why hashes and mtimes both: hashes decide *whether* a side changed (mtime alone is unreliable
across sync tools that rewrite files), mtimes only break the tie when both did.
Why capabilities never sync: a synced folder is writable by whatever syncs it, and grants must
come only from a human editing this machine's file (CLAUDE.md §4). Secrets (vault, gateway
device tokens, TLS identity) live in other files and aren't in `SYNCED_FILES`.
Why sync is core, not an extension: it rewrites extension approvals, which only core may do, and
it must run before the extension host starts anything.

## 6. Control plane

**Transport.** `vscode-jsonrpc` over the unix socket at `controlSocketPath()`. A stale socket
file is unlinked first, and the new socket is chmod 0600.
- A connection must call `hello {token}` first, or every call fails with InvalidRequest.
  Reaching the socket grants nothing.
- A missing capability returns InvalidRequest with `needs-elevation: <cap>`.
- Pane clients receive no push events. Extension processes receive `ext.event` notifications for
  what they subscribed to (§11).

**Identity** (`idRegistry.ts`): each pane gets `{externalId: uuid, token: 32 random bytes hex,
windowId, workspaceId}`. Registering a pane twice returns the existing entry. Agents only ever
see external ids.

**Capabilities** (`shared/capabilities.ts`, `capabilityStore.ts`).
- Defaults for every pane: `drive-self`, `read-board`, `notify`, `settings-read`, `process`,
  `vault-read`, `vault-write`.
- Elevated: `send-other-pane`, `kill-pane`, `all-workspaces`, `shell`, `destructive`, `phone`,
  `gateway`, `browse`, `settings-write`.
- Elevated caps come from `capabilities.grants` in `settings.json` (every pane, read once per
  run, unknown names dropped) or from the human answering an approval request.
- **Approvals** (`main/approvals.ts`, `controlElevation.ts` `ensureCaps`, renderer
  `stores/approvalsStore.ts`, `ApprovalCard`, `ApprovalsInbox`): when a pane caller lacks caps,
  `ensureCaps` holds the call and `createApprovals().request` publishes it to the pane's window
  (`approvals:changed`). The window rings the pane (`signalPane` waiting), posts a notification,
  and shows a card on the pane and a row in the notification center's inbox. The answer comes
  back over `approvals:answer` and counts only from the window that owns the request; `once`
  lets this call through, `session` also `grant`s the caps to that pane identity until
  `pane-closed` (`forget`) or Revoke, `deny` / no window / 90 s timeout refuse with
  `denied:` / `not-approved:`. `approvals.mode: 'allow'` (Settings → Agents) lets requests
  through and only records them, except anything with `destructive`, which always asks and
  never gets a session grant. Extension callers still get `needs-elevation` (their caps are
  manifest ∩ approval). `approvals` is not a `DATA_KEYS` key and is local-only in settings
  sync. Why hold instead of fail: the agent would otherwise need the human to edit
  `settings.json` and restart, then retry; now the same call just continues. Why no palette
  command or socket method answers: an agent must never be able to approve itself.
  `vault.*` params are never shown in a request.
- `phone`, `shell` and `destructive` are never checked on the socket.

**Methods.**
- `controlServer.ts` itself serves `hello`, `whoami`, `command.list`, `command.exec`, `pane.info`,
  `cwd.get`.
- Other modules add methods with `registerControlMethod(name, {cap, callers, handler})`;
  `callers` defaults to `panes` (see §11 for extension identities).
- `command.exec` goes through main's `execCommand`: `command:invoke` IPC to a window's registry,
  answered by `command:result`, 5 s timeout. A target with no window goes to the main window.
  `pane.list`, `workspace.list` and `workspace.groups` ask every window and concatenate the
  answers, main window first (`paneList.ts`), so agents see detached workspaces too.
- If the target differs from the caller's own pane, window or workspace in any way, the caller
  needs `all-workspaces`. Each command's declared capabilities are checked as well.
- Workspace groups: `workspace.list` entries carry `groupId` for grouped workspaces, and
  `workspace.groups` (`paneList.ts`, read-board, all callers) returns `{groupId, name, color?,
  collapsed, workspaceIds}`. `pine workspace group <name>` / `ungroup` run `workspace.group` /
  `workspace.ungroup` on the caller's own workspace, so moving another workspace would need a
  target and therefore `all-workspaces`. `pine workspace list [--json]` prints both lists. The
  gateway's `toWireSession` drops `groupId`, so `session.list` stays the companion's contract.

**Toolbelt** (all `registerControlMethod`):

| Module | Methods | Notes |
|---|---|---|
| `processManager.ts` | `process.run/list/info/output/kill/restart` | Details below |
| `vault.ts` | `vault.set/get/list/delete` | Details below |
| `bus.ts` | `bus.send/inbox/wait/handoff/claim/handoffs/update` | Details below |
| `notify.ts` | `notify`, `notify.list` | Desktop notification + log entry (capped at 500), marks the caller's pane unread via `attention.notify`; emits a `notify` platform event |
| `attention.ts` | `pane.setAttention` | `pine state`; see §5 "Live workspace state and attention" |
| `docs.ts` | `docs` | Static CLI help, no capability needed |
| `paneList.ts` | `pane.list`, `workspace.list` | Needs `read-board`; panes without an external id are omitted |
| `workflows.ts` | `workflow.list` | Needs `read-board`; the caller's own workspace's `.pine/workflows`, the user's folder and extension workflows as `{workflows, problems}`. `pine workflow list|show` read it; there is no run or save verb (§4) |

- **`process.*`**:
  - Uses `child_process.spawn` with `detached`, so `killTree` can signal the process group and
    take grandchildren (dev servers) down too.
  - Only the command's first word is persisted, so secrets in args never reach disk.
  - A process owned by another workspace reports `not-found`, the same as a missing one, so ids
    can't be probed.
  - At load, `running` entries become `exited` and the id counter is advanced past saved ids.
- **`vault.*`**: encrypted with Electron `safeStorage`. With no OS keyring it refuses with
  `encryption-unavailable` and never falls back to plaintext. Files are 0600 and dirs 0700.
  `list` returns names only.
- **`bus.*`**:
  - Sending to yourself is free; another pane needs `send-other-pane`, and `--all` handoffs
    need `all-workspaces`.
  - `wait` checks the inbox before blocking, with a timeout clamped to 1–120 s (default 30 s).
  - Each inbox keeps up to 200 messages and the handoff list up to 500 (finished handoffs are
    evicted first).
- Boards, cards and knowledge entries are not pine's: they live in Trellis, which the built-in
  `trellis` extension shows (§11). pine's own kanban and wiki extensions were removed.

Project-scoped stores refuse with `no-project-workdir` while the workspace's workDir is unknown.
Why: `jsonStore` would otherwise fall back to main's cwd and pool every unknown workspace into one
file. Writing to global scope needs `all-workspaces`; reading it does not.

`protoGuard.isDangerousSegment` rejects `__proto__`, `prototype` and `constructor`. Settings
dot-paths check every segment, not just the last one; snapshot pane-id keys are checked too.

**CLI** (`src/cli/index.ts`):
- Reads `PINE_SOCKET` and `PINE_TOKEN`. A verb containing a dot is sent as `command.exec` with
  the next argument parsed as JSON. A bare verb that isn't a core verb is an extension id:
  `pine git diff x` is `pine ext git diff x`, i.e. `ext.invoke {extId, command, args: {argv,
  stdin?}}`. The CLI reads stdin only for commands whose manifest says `stdin: true`. Why: an
  agent harness often leaves stdin open, so reading it unconditionally would hang every call.
- `pine pane.list` calls the socket method directly, because only that method maps to external ids.
- `pine vault set` reads the secret from stdin with echo off, and restores the tty on every exit path.
- `pine settings get/set` goes through renderer commands so the Settings UI updates live.

The agent-facing guide is the `pine` skill (`.claude/skills/pine/`).

**Manager portal** (`portal.ts`, `portalCaller.ts`, `manager.ts`, `cli/portal.ts`; spec
`specs/manager/`). From a terminal outside Pine, `pine <agent> [args…]` opens one manager
workspace running that agent and mirrors it in the terminal.
- The CLI takes this path only when `PINE_SOCKET` is unset and stdin and stdout are terminals;
  otherwise it prints the old "not inside a Pine pane" error, so scripts and agents learn nothing
  about the manager. It connects to `$XDG_RUNTIME_DIR/pine-portal.sock` (`pine-dev-portal.sock`
  unpackaged, `PINE_PORTAL_SOCKET` overrides). If nothing answers and `PINE_APP_BIN` is set (the
  `~/.local/bin/pine` launcher that `install-linux.sh` writes), it starts Pine with `--hidden`
  and polls for up to 20 s.
- The portal is a second socket, not the control socket, with one request (`portal.open {agent,
  args, cwd, cols, rows, path}`) and three notifications (`mirror.data`/`mirror.exit` out,
  `mirror.input`/`mirror.resize` in). It carries no token and grants nothing but the mirror; the
  agent's own powers come from the manager pane's `PINE_TOKEN`. Why a second socket: the control
  socket answers panes by token, and the portal's caller has none.
- **Caller check.** Node can't read `SO_PEERCRED`, so `callerVerdict` fstat's the accepted
  socket for its inode, runs `ss -xpnH` (execFile, no shell) and takes the pids holding the peer
  end. Any of them inside Pine refuses the request (`inside-pine`): Pine's main pid among its
  ancestors (covers pane shells, extensions and background processes), `PINE_TOKEN` in its
  `/proc/<pid>/environ`, or a controlling tty that is one of Pine's ptys (the manager's own
  included). Anything unreadable refuses too (`unknown-caller`). There is no approval prompt, so
  this check is the whole gate (§8 has the gap). `ss` is the `manager` system requirement
  (`systemRequirements.ts`): without it `portal.open` refuses first with `missing-requirements`
  and the install hint, and Settings → Manager offers the System extension's approved install.
- **One manager, one mirror.** `ManagerService` keeps one `{paneId, agent}`: the same agent
  attaches, another fails `manager-busy`, concurrent opens share one start. The portal keeps one
  mirror slot (`mirror-attached`). Presets are `manager.agents` in settings.json merged over the
  built-in claude and codex (`parseManagerAgents`); the renderer carries the section through
  saves but it is not in `DATA_KEYS`.
- **The agent is the pane's process.** Main asks the renderer for a manager workspace
  (`manager:open`, answered by the main window's `managerBridge.ts` once it sent `manager:ready`;
  `managerWindowId` waits for the main window, never a detached one), then spawns the
  preset's argv plus the extra args directly with node-pty (`spawnManagerPty`): no shell, nothing
  typed, the caller's cwd and PATH, and the pane's `PINE_*` env. Why: typing a command needs an
  idle prompt and quoting; spawning an argv needs neither. The entry is `keepAlive`, so the detach
  reaper skips it; it ends when the agent exits or the human closes its pane (`pane-closed` kills
  it).
- **Pine's view is read-only.** The `manager` pane kind renders `ManagerView`: an xterm with
  `disableStdin` that attaches as an attach-only observer (`attachOnly` never spawns a shell), so
  `pty:write` from it fails `canWrite`. Main ignores `pty:resize` for keep-alive entries; the
  mirror is the owner and sets the size, and main tells observers through `pty:size:<paneId>`.
  The manager workspace (`kind: 'manager'`) is left out of the snapshot, and closing it asks like
  a running command.
- While a manager is live, closing the window hides Pine to the tray (`closeAction`).
- **Manager powers** (`managerMethods.ts`, `managerAgent.ts`). `spawnManagerPty` marks the
  pane's identity (`markManager`) and sets `MANAGER_CAPABILITIES`: every cap but `phone`,
  `gateway` and `destructive`, so it acts across workspaces without asking and `destructive`
  still asks. `callers: 'manager'` methods: `manager.read` (the pane's `ScreenMirror.screenText`,
  the active buffer so a TUI is readable, capped at 2000 lines), `manager.spawn` (a preset's argv
  typed into a new terminal pane by `openTerminalInWindow`, in a new workspace from
  `workspace.new`, which returns its id) and `manager.input` (text plus named keys, only with
  `manager.allowInput`). Neither reaches the manager's own pane. Limits live in
  `manager.limits`: live workers (panes still registered), spawns per 10 minutes and bus sends
  per minute (`RateWindow`, `bus.send` asks `managerSendAllowed`). Why rate limits and not a hop
  count: bus messages have no thread to count hops on. `pine docs` adds `MANAGER_HELP` only for
  the manager, and the CLI verbs (`cli/manager.ts`) are not in its usage text.
- **The manager's agent setup.** Before each spawn main rewrites
  `privateTmpDir('pine-manager')`: a claude plugin (`pine-manager` skill, symlinks to the
  human's `manager.skills` folders that hold a SKILL.md, and the same resume/state hooks as the
  worker plugin) and a codex context file. `managerArgv` adds `--plugin-dir` for claude and
  `codexHookArgs` for codex, recognized by program name; other presets run as given. Why a
  separate plugin: the manager must not get the worker `pine` skill and workers must not get
  the manager's, and a directly spawned agent skips the shell's `claude()`/`codex()` wrappers.
- **Resume.** The hooks' `pine resume-token` reaches `pane.setResume`, which hands a manager's
  token to `ManagerService.rememberResume` (`manager-resume.json` in the data dir). If Pine quits
  with the manager running (`shutdown()` before the kill loop), the token stays and the next
  `pine <same preset>` without extra args starts with `--resume <id>` / `resume <id>`. If the
  agent exits on its own the token is cleared, so the next start is fresh.
- **Approvals while hidden.** An approval card that waits for the human calls `reveal`, which
  shows a hidden window from the tray; otherwise a manager's `destructive` request would time out
  unseen.
- **Settings → Manager** (`ManagerSection.tsx`, Linux only) edits `manager` through
  `setManager`, which runs `parseManagerSettings` (shared with main); presets are typed as a
  command line and split by `splitArgs` (`shared/argv.ts`, also the external editor's splitter).

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
- **Workspace.**
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
    `agent.done` need the `notify` cap; `workspace.state` and `pane.state` need `read`. `notify`'s
    `from` is rewritten to the pane's external id (or `null`), the id space phones see.
  - Emitters: `pine notify` (`notify.ts`) emits `notify`; the renderer's `workspace-state`
    lifecycle event goes through `emitSessionState` (`events.ts`), which emits `workspace.state`
    plus `agent.needs-input` for `waiting` and `agent.done` for `done`; `terminal:state` emits
    `pane.state`.
- **Revocation** has two parts and both must stay. `closeDeviceSockets` closes live sockets with
  code 4003, and every authenticated frame re-reads the device from the store (`refreshDevice`):
  gone means close 4003, present means its caps replace the socket's cached ones.
- **Grants** (`devices.setDeviceCap`, Settings → Remote per-device switches): only
  `PHONE_GRANTABLE_CAPS` (`command`, `input`, `destructive`) can change; the base
  caps can't be stripped. `destructive` requires `command` and is dropped when `command` is;
  the UI asks for confirmation before granting it. After a change, `applyDeviceCaps` updates live
  sockets: if any cap was removed they are closed with 4004 `caps-changed` (and their pty
  attachment detached); if caps were only added they get a `caps.changed` event.
  Why: closing on removal is the simple correct option. An owner attachment made under the old
  caps can't linger, and the phone's reconnect + `hello` returns the smaller set. Additions
  don't need a reconnect, and the per-frame re-read makes them effective immediately.
- **Wire names** (`controlDispatch.ts` `toWireSession`/`toWirePane`, `main/events.ts`): the
  phone contract predates the session → workspace rename and still says `session`; the gateway
  translates `workspaceId` to `sessionId` on the way out. Why: renaming the wire breaks the
  companion app until it ships the same change.
- **Phone capabilities** (`controlDispatch.ts`) are a separate vocabulary from the internal
  `Capability` set, and the gateway checks them itself.
  - `read` allows `workspace.list`, `pane.list`, `command.list`, `pane.info`, `cwd.get`.
  - `command` allows `command.exec`. There are no board methods: `board.get`/`board.update` and
    the `board.read`/`board.write` caps went with the kanban extension (contract v1.2). Device
    records are normalized on load (`devices.ts`), so caps pine no longer knows are dropped.
  - A missing cap returns `-32003 needs-elevation`.
  - `PHONE_CAP_ALLOWS` is an allowlist from phone caps to internal caps. Why: an earlier bug let
    `command` alone run any command. `input` must never map to a command cap; it only gates
    `0x02` frames.
  - A non-empty target that doesn't resolve is an error, never a fallback to the default window.
  - Only the desktop Settings UI raises a device above its default caps (see Grants).

## 8. Workspace restore

Two files written by two processes (see CLAUDE.md §6): the renderers write `workspaces.json`
(layout), and main writes `scrollback.json` (each pane's serialized screen).

- **One file, many windows** (`windowBroker.ts`, `windowBook.ts`): each renderer saves only its
  own snapshot; main keeps one per window slot (`main` or a detached window's stable 8-char id)
  and writes the merge: the main window at the top level, each detached window under `windows:
  [{id, bounds, activeWorkspaceId, workspaces}]`. Why: a renderer that wrote the whole file erased
  the other windows' workspaces. A move updates both slots in main at once, so the file never
  holds a workspace twice or loses it between the two renderers' next saves. Bounds are the
  window's normal bounds, saved after a move or resize (debounced) and on close.
  - On start, main opens the main window, then one detached window per saved slot, with its bounds
    clamped (`clampBounds`) onto the display it overlaps most, else the primary one, shrunk to
    fit. Each renderer's `workspace.load()` returns only its own slot, restored idle like any
    other workspace.
  - `parseSnapshot` claims pane and workspace ids across all windows, so an id held twice keeps
    only its first owner; a window with invalid bounds or id, or no workspaces, is dropped. A
    `hibernated` mark is only accepted in a handoff (`parseHandoff`), never from the file.

- **Layout** (`stores/persistence.ts`, `layout/snapshot.ts`): saved 400 ms after any change to the
  workspaces, layout or settings stores, but at least every 2 s while changes keep coming
  (`SAVE_MAX_WAIT_MS`), plus once at start and once on `beforeunload`. Why the cap: those stores
  can change more often than every 400 ms while terminals are busy, so a plain debounce could
  postpone the write indefinitely, and a renderer that crashed (no `beforeunload`) reloaded the boot snapshot and its recovery reaped
  the shells of every pane missing from it.
  - With no workspaces, `buildSnapshot` writes an empty workspace (`workspaces: []`,
    `activeWorkspaceId: null`) and `parseSnapshot` accepts it, so a restart after closing every
    workspace restores zero workspaces instead of the last non-empty snapshot.
  - `zoomedPaneId` is not saved.
  - Diff panes are not saved (`withoutKind(root, 'diff')`); a workspace whose only pane is a diff
    comes back as a terminal at its workDir, and focus moves to a surviving pane. Why: their
    content is in memory only (nothing live is restored).
  - The two node converters are a compile-time check that `layout/types.ts` and the snapshot
    types in `shared/types.ts` agree.
  - Groups are saved as `groups: [{id, name, color?, collapsed?}]` plus each member's `groupId`;
    a group with no members is not written. `parseSnapshot` keeps at most 32 groups with a known
    color and a non-empty name (≤ 60 chars), drops a `groupId` that names no kept group or sits on
    a pinned workspace, and drops groups nobody joins. The renderer normalizes the order again
    on `hydrate`.
- **Scrollback**: main saves it every 5 s (unref'd timer, skipped when no pane's ring cursor
  moved) and again at `before-quit`, so a crash loses at most 5 s. The saved copy is capped at
  128 KB per pane (the live ring holds 1 MB).
  - Each pty entry owns a `ScreenMirror` (`@xterm/headless`, 2000 lines of scrollback) fed every
    byte the ring gets, restored history included (`feedPty`), resized with the pty (`resizePty`:
    `pty:resize` and the gateway's `ptyResize`), and disposed when the pty is killed, exits or the
    app quits. Resizes are queued behind the bytes already written (a `write('', cb)`), because
    headless parsing is async and bytes emitted at the old width must be parsed at it.
  - A save stores `ScreenMirror.serialize()` of the normal buffer: at most 1000 rows, as logical
    lines (soft-wrapped rows joined), each cell's text with its SGR, empty cells as spaces,
    trailing blanks trimmed, lines joined by `\r\n`. No cursor movement at all. Why: that text
    rewraps on its own at any width, the way a live resize reflows. Why not `@xterm/addon-serialize`
    (tried first): it encodes gaps as cursor-forward moves and wrapped rows with trailing gaps as
    a `-----` + erase trick that only works at the exact width it was serialized at. A
    right-aligned RPROMPT replayed into a narrower pane clamped at the edge and split (`1` /
    `2:40:42`), and when the pane resized between `pty:attach` and the replay the trick printed
    rows of dashes.
  - The saved range stops before the shell's idle prompt: the mirror keeps an xterm marker at the
    last OSC 133;A (cleared at C), and the range ends on the line above it (on it if the prompt
    started mid-line, so output without a trailing newline survives). Leading and trailing blank
    lines are dropped. Why: the restored pane gets a fresh prompt right under the seam, so the
    old idle prompt (with its stale clock) would read as a duplicate. With a command running at
    quit, or a shell without integration, the whole screen is kept.
  - Restore pushes the saved text plus `RESTORE_SEAM` through the ring once, as before. The text
    ends without a newline; the seam's own `\r\n` puts it on the next line.
  - Why serialized state and not raw bytes: a raw pty stream only replays correctly into a
    terminal with the same geometry and state. zsh's PROMPT_SP (`%` + `COLUMNS-1` spaces +
    `\r \r`) left a visible `%` at a different width, and powerlevel10k's cursor-positioned
    RPROMPT/clock redraws left fragments (`:41`) and duplicated prompt lines. VS Code's pty host
    persists terminals from a headless xterm the same way.
  - Live attach and remount replay still use the raw ring (same pty, and the OSC 133 marks
    rebuild blocks). Serialized history has no marks, so restored history has no blocks.
  - An old `scrollback.json` holding raw bytes loads as history once; the next save replaces it.
  - `persistScrollback` merges `pendingRestoredScrollback()`. Why: a restored pane that is never
    attached this run keeps its history through a second restart.
- **Quit order**: `persistScrollback` → kill ptys → `killAllLsp` → `killAllProcesses` →
  `stopControlServer` → `stopGateway`.
- **Validation** (`parseSnapshot`): files are hand-editable, so a corrupt one degrades to a cold boot.
  - The file must have `v === 1`. Limits: 32 workspaces, 64 panes, tree depth 12.
  - A duplicate pane id drops that workspace, and bad `sizes` fall back to an even split.
  - Pane-id keys pass `isDangerousSegment` and go into a `Map`.
- **Boot** (`main.tsx`):
  - `hydrate(snapshot)` must run before the first render. Why: the first render must already
    see the restored workspaces; a pane mounted earlier would spawn a pty that hydration orphans.
  - If loading fails or there is nothing to restore, the app boots with no workspaces.
  - `workspacesStore.hydrate` / `layoutStore.hydrate` re-emit `workspace-added`, `workspace-activated`
    and `pane-created`. Why: restored items never went through `ensure`/`split`, so main's id
    registry and the socket would otherwise not know them.
- **Turning `restoreWorkspace` off** calls `workspace.save(null)`, which deletes both files and
  stops scrollback writes.

## 9. Editor, LSP, browser

- **Files changed on disk** (spec `specs/editor-reload.md`): main watches the *folder* of every
  file open in an editor (`main/fileWatch.ts`, Node `fs.watch`, debounced, confined to the `fs:*`
  roots, refcounted per window) and sends `fs:changed` to the windows that have it open; the
  editor also re-checks on window focus. Why the folder: agents and editors save by writing a
  temp file and renaming it over the old one, which silently ends a watch on the file itself.
  The editor keeps the text it last loaded or saved as its baseline (`diskBase` in
  `Editor.tsx`). A clean buffer reloads as a minimal line edit between undo stops
  (`lib/diskReload.ts`), so the cursor stays and Ctrl+Z restores the old text. A dirty buffer is
  never touched: the "Changed on disk" bar offers Compare (diff surface, disk left), Reload and
  Keep mine (the human's text becomes the baseline). A save first compares the disk with the
  baseline and holds with Overwrite / Compare / Cancel if it moved; autosave never writes while
  a bar is up. Re-checks are coalesced to one running plus one pending.
  While a bar is up the pane tab shows a warning dot (`pane-disk-mark`, from `disk` in
  `editorStatusStore`), a deleted file's title is struck through, and a deleted file counts as
  unsaved in close, quit and move prompts (`unsavedFilesOf`). After a reload the changed lines
  get a whole-line decoration (`editor-reload-highlight`, `--motion-highlight`) removed after
  2 s; under reduced motion it's static. Why only reloads: the human's own typing must never
  look like someone else's change.

- **Monaco** (`monaco/setup.ts`, `components/Editor.tsx`):
  - Workers are bundled with Vite `?worker` imports (editor, json, css, html, ts), with no CDN.
  - The editor theme is derived from the scheme `useScheme('editor')` resolves from
    `editor.theme` (same rules as the terminal): `monacoThemeData` (`monaco/monacoTheme.ts`, pure)
    maps ANSI colors onto Monaco token rules and editor colors, and `useMonacoTheme` defines it as
    `pine-scheme-<id>` and sets it (`monaco.editor.setTheme` is global, so every open editor and
    diff follows). Why derive instead of shipping Monaco themes: one scheme then colors the terminal,
    the editor and the Settings preview identically, and a plugin scheme gets an editor theme free.
  - Ctrl/Cmd+S saves through `fs.write`. Dirty state compares `getAlternativeVersionId` with the
    saved version (mirrored to `editorStatusStore`).
  - Files with a NUL byte in the first 8 KB are not opened.
- **Image and PDF viewers** (`components/ImageViewer.tsx`, `PdfViewer.tsx`, `ViewerChrome.tsx`,
  `lib/viewerHooks.ts`, `lib/regionSelect.ts`, `lib/pdf.ts`):
  - Bytes come from `fs.readBinary` (`main/fsBinary.ts`): confined by `resolveSafe` like every
    `fs:*` call; it `stat`s first and refuses a file over 50 MiB (`too-large` with the size)
    without reading it. Why bytes and not a `file://` URL: the renderer has no file access and
    the CSP allows only `self`, `data:` and `blob:` images; a `Uint8Array` crosses IPC without
    base64 inflation.
  - Images render from a blob URL (revoked on unmount) and fit the pane (never upscaled) or zoom
    in steps (`ZOOM_STEPS`). PDFs render one page at a time on a canvas at `devicePixelRatio`,
    fit to width by default, with pdf.js's `TextLayer` on top for selection (`index.css`
    `.pdf-text`, a trimmed copy of pdf.js's `.textLayer` rules; the page sets
    `--total-scale-factor`). Why the legacy build: the modern build calls
    `Map.prototype.getOrInsertComputed` and `Math.sumPrecise`, which Electron 33's Chromium
    lacks; the legacy build polyfills them. The worker is the same build's `pdf.worker.min.mjs`,
    loaded with a Vite `?url` import. pdf.js is imported lazily, so it loads only when a PDF opens.
    `pdfjs-dist` is a devDependency: Vite bundles it into the renderer, and as a runtime
    dependency electron-builder would also ship its optional native `@napi-rs/canvas`.
  - A region is dragged with pointer events in content coordinates (`toContentPoint` divides by
    the zoom), normalized and clamped by `dragRegion` (whole units, at least 2×2). Image regions
    are in image pixels; PDF regions are in PDF points with a top-left origin, scaled to canvas
    pixels only when cropping (`pixelRect`). PDFs have a region mode that takes the text layer
    off the pointer, so a drag never fights text selection.
- **Send selection to agent** (`commands/selectionSend.ts`, `lib/selectionSenders.ts`,
  `components/SelectionSend.tsx`, `lib/sendPick.ts` `sendSelectionToPane`,
  `main/selectionReport.ts`, `shared/selection.ts`):
  - Every file view and terminal registers a sender for its pane. A terminal's sender takes the
    xterm selection, or, with none, the selected block's output and command (the block menu's
    "Send output to agent…" selects the block and clears the xterm selection first); it sends a
    `terminal` capture (`cwd`, `command`, `text`), the one kind without a `file`. The `selection.sendToAgent` command (palette,
    Ctrl+Shift+E / ⌘⇧E, Monaco's context menu, the viewers' toolbar button, the Markdown
    preview's button) runs the active pane's sender, which captures the selection and opens the
    same send panel as pick element (`PickSendPanel`: targets with state dots, a note,
    Ctrl/⌘+Enter sends).
  - What is captured: Monaco's selection (`line:column`, 1-based, end exclusive) and its text; in
    the Markdown preview, the DOM selection's text and the source lines of the blocks it spans (a
    rehype plugin tags every element with `data-line-start`/`data-line-end`); in a PDF, the
    text-layer selection and its page; for an image or PDF region (or the whole image or page
    when nothing is drawn), a PNG cropped on a canvas in the renderer. DOM selections are tracked
    on `selectionchange` and survive focus moving elsewhere, since opening the palette would
    otherwise clear them before the command runs.
  - Why the capture travels whole and not as an id (unlike pick element): the renderer already
    holds the file, text and pixels, so main has nothing to look up. Main treats it as untrusted:
    `normalizeSelection` checks the kind, an absolute path, positive integers and non-empty text
    (clipped to 50 000 chars); the note is clipped to 4000; an image must be a PNG (signature
    check) of at most 25 MiB; and the sender window must own the source pane.
  - Main writes `selection-N.png` (when there is one) and `selection-N.md` with the same `N` in
    `privateTmpDir('pine-reports')` (mode 0600, `wx`, never overwritten), and posts a `selection`
    bus message from the source pane to the target:
    `{"kind":"selection","report":"<md>","file":"<path>","image":"<png>|null","note":"…"}`.
    The renderer delivers `@<report path> ` exactly like a pick report (`canInsertReference`,
    otherwise the clipboard) and sets the target to `working`.
  - Report format (`renderSelectionReport`), one `# <kind>: <label>` heading, then `## Note`
    (the note or `(no note)`), `## Source` and, for text, `## Selected text`:

    | Kind | Title | Source lines |
    |---|---|---|
    | Monaco text | `Text selection: a.ts:12:5-14:1` | `File`, `Lines: 12:5-14:1 (line:column, 1-based, end exclusive)`, `Captured` |
    | Markdown preview text | `Text selection: README.md:3-6` | `File`, `Lines: 3-6 (source lines of the block selected in the Markdown preview)`, `Captured` |
    | Image | `Image region: a.png (x 10, y 20, 100 × 50)` or `Image: a.png` | `File`, `Image size: W × H px`, `Region: x, y, w × h (image px, origin top-left)` or `whole image`, `Snapshot: <png>`, `Captured` |
    | PDF text | `PDF text selection: a.pdf, page 2` | `File`, `Pages: 2 (1-based)`, `Captured` |
    | PDF region | `PDF page region: a.pdf, page 2 (x …)` or `PDF page: a.pdf, page 2` | `File`, `Page: 2 (1-based), W × H pt`, `Region: … (PDF points, origin top-left)` or `whole page`, `Snapshot: <png>`, `Captured` |
    | Terminal | `Terminal text: Terminal selection` or `Terminal output: $ <command>` | `Directory`, `Command` (block only), `Captured`, then `## Terminal text` |
- **File path menu** (`components/FileMenu.tsx`, on file-tree rows and editor tabs): Copy path,
  Copy relative path (to the workspace `workDir`), and Send path to agent, a submenu of the same
  targets as the send panel. Sending pastes only `@<path> ` (`insertPathReference`) and focuses a
  same-workspace target; no report is written. Why a target is disabled ("busy") instead of
  falling back to the clipboard: the menu closes on click, so a silent clipboard copy would look
  like a send that did nothing. The tree highlights the row of the active editor pane's file
  (`aria-current`); since an editor pane's `cwd` is its file's folder, that row is always at the
  tree's top level.
- **Auto-resume after a restart** (`agents.autoResume`, `lib/autoResume.ts`): the resume token
  stays on a pane after its agent exits, so the snapshot also records `agentRunning` for panes
  whose running command is that agent at save time (`liveAgentPanes` in `stores/persistence.ts`,
  which re-saves when `running` changes); once quit is approved `freezeSnapshots()` saves one
  last time and stops, so the shells dying at quit can't clear the mark. Restore turns it into
  `resumePending` on the pane. `startAutoResume` then, when the setting is on and the pane is
  visible (`isPaneVisible`: active workspace, shown tab, not behind Settings), types
  `resumeCommand` at the pane's first idle prompt (`runWhenIdle`) and clears the mark; a
  background tab or another workspace waits until it's shown. The mark is dropped (no resume)
  when the setting is off or a command runs in the pane first. A still-pending pane is saved
  as `agentRunning` again, so quitting before visiting it keeps it. Why visible only: restoring
  many workspaces would otherwise start every agent at once.
- **Agent session button** (`components/AgentSessionButton.tsx`, `lib/agentSession.ts`): the pane
  header shows a robot icon with a state dot only while the pane's running command is an agent
  (`runningAgentOf`, `lib/paneAgent.ts`). A running command is an agent when its first word is
  `claude`/`codex` (`commandAgent`), or when it was marked while running: by the agent's own
  `pine resume-token` (`resume.set` → `markAgent`), or by `startAgentDetection`, which asks
  main for the pty's foreground process name (`pty:foreground`, node-pty's `process`, answered
  only to the pane's own window) 0.8 s, 3 s and 10 s after a command starts. Why: an alias such
  as `cc` hides the program from the command text, and an alias that skips Pine's `claude`
  wrapper never reports a session id; the popover then says Not resumable. The mark is dropped
  when the block ends. Hibernation, auto-resume, the send-path targets and snapshot marks all
  use `runningAgentOf`. Its popover lists only what Pine knows: the title the agent set on the
  terminal (spinner glyph stripped, `sessionTitle`), the resume id from its SessionStart hook,
  the attention state and message, how long it has run, its folder and command, and whether it
  is resumable (a resume id was reported). While the popover is open it asks main every 3 s for
  `agent:session-info` (`main/agentTranscript.ts`): main finds the agent's own transcript from
  the validated resume id alone (`~/.claude/projects/*/<id>.jsonl`, or Codex's
  `~/.codex/sessions/YYYY/MM/DD/*-<id>.jsonl`; symlinks refused), reads its last 512 KiB (plus
  the first line for Codex's session header) and returns only parsed fields
  (`shared/agentSessionInfo.ts`): title (`ai-title`, or a `custom-title` the human set), model,
  context tokens (Claude: input + cache creation + cache read of the last main-thread reply;
  Codex: last `input_tokens` against `model_context_window`), cwd, branch, version, mode and
  effort. A field the transcript lacks is simply not shown. Why read the transcript: the hooks
  carry none of this, and never take a path from the agent, so a pane can't point main at
  another file.
- **User actions** (`settings/actions.ts`, `lib/userActions.ts`, `PaneTabMenu.tsx`,
  `ActionConfirmDialog`, `ActionsSection`): `settings.json` `actions` is a data list
  (`parseActions`: id, title, palette `command`, `args`, an icon from `ACTION_ICONS`, places
  `paneHeader` / `tabMenu`, optional `paneKinds`). `startUserActions` registers each as palette
  command `action.<id>` (so keybindings work) and re-registers on change; the pane header
  and the tab context menu render them per pane kind. `runUserAction` fills `{cwd}` / `{file}`
  from the pane, and if the command declares any capability outside `DEFAULT_CAPABILITIES`
  and its `actionFingerprint` (command + args, not the title) isn't in `trustedActions`,
  asks first (Run once / Run and trust / Cancel) showing the exact command and args. Why
  data and not code: agents can add actions with `pine settings set` (behind the
  `settings-write` approval), and a click is still the human's; why the trust prompt: an
  agent could otherwise label a button misleadingly over a command that types or
  destroys. `trustedActions` is not a `DATA_KEYS` key and is local-only in settings sync.
- **Update detection** (`main/appUpdate.ts`, `scripts/build-info.mjs`, `stores/updateStore.ts`,
  `UpdateNotice`): every build writes `{version, commit, builtAt}` to `out/build-info.json`,
  which electron-builder copies next to the app as `resources/build-info.json`. A packaged app
  reads it at start, then re-reads it every 30 s and on window focus; when the file on disk
  names a different build (a reinstall with `pnpm install:local` replaced the app folder), main
  sends `app:update-available` once per build. The top bar shows "Restart to update" (with
  Later), and a desktop notification appears if the window isn't focused. Restart is
  `app.relaunch()` + `app.quit()`, so the close guard still asks about running commands and
  workspaces restore as usual. Why a file outside `app.asar`: Electron caches an archive's
  header, so reading a replaced asar can return the old contents. Dev builds (`pnpm dev`) don't
  watch.
- **Saved passwords** (`main/credentials.ts`, `shared/credentials.ts`, `PasswordsSection`):
  `credentials.json` in the data dir holds `{id, origin, username, secret, updatedAt}` with
  `secret` = `safeStorage`-encrypted password. Entries key on the exact origin
  (`normalizeOrigin`), so `https://github.com.evil.io` never matches `https://github.com`;
  the same origin + username updates in place. IPC: `credentials:list` (summaries only),
  `save`, `remove`, `copy-password` (main writes the clipboard), `import` (main opens a file
  dialog and reads a Chrome / Firefox / Bitwarden CSV by column name, `passwordRowsFromCsv`).
  Why main and not the browser session: Electron ships no password manager, and anything in
  the page's storage is readable by the page.
- **Password autofill** (`main/loginFill.ts`, `shared/loginScripts.ts`, `LoginButton`): the browser
  toolbar's key button lists the saved logins for the page's exact origin
  (`credentials:for-page`, summaries only). Filling re-checks the guest's current origin against
  the chosen login, then runs `fillScript` in its own isolated world (`LOGIN_WORLD_ID`): it finds
  the first visible password field and the username field before it in the same form, and sets
  both through the native value setter with input/change events. "Save login from this page"
  reads those fields (`readScript`) and saves them. Agents call `browse.login` (`pine browse
  login [--user]`): it needs `browse`, then the `credentials` capability, which is in
  `ALWAYS_ASK`, so every use shows an approval card naming the site; the reply is only the
  origin and username. Why an isolated world: the page never sees the script or the password
  except as the field value it asked the human to type.
- **Window title** (`settings/windowTitle.ts`, `lib/useWindowTitle.ts`): `appearance.windowTitle`
  is a template (`{workspace}`, `{pane}`, `{cwd}`, `{product}`) set as `document.title`, which
  Electron uses for the OS window title; separators left at the edges by an empty value are
  trimmed, and an empty result falls back to the product name.
- **Terminal link cursor** (`lib/linkModifier.ts`): file and URL links open only with Ctrl (⌘ on
  macOS), so the host carries `link-modifier` while that key is held and CSS lets xterm's
  `xterm-cursor-pointer` show only then; otherwise the cursor stays the I-beam.

    `## Selected text` holds the selection in a fence (tagged with the file extension for Monaco
    text), lengthened when the text itself contains a fence.
- **Diff view** (`components/DiffView.tsx`): Monaco's `createDiffEditor`, read-only
  (`originalEditable: false`), side-by-side with an inline toggle, same theme and editor font as
  the editor. Models are plain in-memory models (no file URI), so they never collide with an open
  editor's model; they are disposed when the content changes or the pane unmounts. Core knows
  nothing about git: any extension can open one via `ext.openDiff` (§11).
- **Browser and editor settings** (Settings → Browser / Editor, `components/BrowserEditorSettings.tsx`):
  - Address bar: `lib/browserAddress.ts` turns text that is neither a URL nor a bare host into
    `searchUrl()` for `browser.searchEngine`; `custom` uses `browser.customSearchUrl`, valid only
    if it is http/https and contains `{query}`, else Google is used. Zoom: the webview gets
    `setZoomFactor(browser.defaultZoom / 100)` on each `dom-ready`.
  - Terminal links: Ctrl/Cmd+click still goes through the `WebLinksAddon` handler; with
    `browser.openTerminalLinks` it calls `layoutStore.openBrowser` (reuses the workspace's browser
    pane, else splits one) instead of `window.open` (system browser via `openExternalSafe`).
  - Editor: `Editor.tsx` applies word wrap, line numbers, tab size and insert spaces live through
    `editor.updateOptions` (`detectIndentation: false`). Saving is one `save()` used by Ctrl+S and
    auto save: `saveFormatted` runs Monaco's `editor.action.formatDocument` first when
    `editor.formatOnSave`, ignoring a formatter error, then writes. The LSP client registers a
    document formatting provider (`textDocument/formatting`) per language, so servers that offer
    it back that action. Auto save `afterDelay` uses `createAutoSave` (1 s after the last
    change, dirty files only); `onFocusChange` saves on editor text blur. Why: both reuse
    dirty tracking (`savedVersions`, `editorStatusStore`), so a save that lost a race with an edit
    leaves the file dirty.
- **Open in External Editor** (command `editor.openExternal`, the editor's context menu, the
  diff toolbar):
  - Editor and diff surfaces register a position source per pane (`lib/editorPositions.ts`);
    the command asks the active pane for `{file, line, column}` (the diff uses the modified
    side's cursor).
  - Main (`externalEditor.ts`, IPC `editor:open-external`) resolves the template: `auto`
    (default) takes the first of `code -g`, `cursor -g`, `zed` found on `PATH`; empty disables;
    anything else is a custom command line. The template is split into argv (quotes group, no
    other shell syntax), then `{file}`, `{line}`, `{column}` are substituted inside each
    argument, and the program is spawned detached with `shell: false`. Why: a path such as
    `a; rm -rf ~` stays one literal argument. A template without `{file}` gets the file
    appended. The file must be absolute.
  - `settings.set` (agents, phone) refuses `behavior.externalEditor`, directly or through a
    `behavior` object. Why: it names a program pine runs on the user's click, so only the human
    edits it (Settings → Files, or `settings.json`). The same list (`PROGRAM_SETTINGS`) holds
    `notifications.command`, `agents.autoResume` and `terminal.warnOnRiskyPaste`.
- **Appearance settings** (`lib/theme.ts`, `lib/color.ts`, `stores/systemThemeStore.ts`):
  - The effective theme is `theme`, or with `followSystem` the `lightTheme`/`darkTheme` picked by
    the OS. Why main and not `matchMedia`: in Electron on Linux `prefers-color-scheme` does not
    follow `nativeTheme.themeSource` (verified under xvfb), while `nativeTheme.shouldUseDarkColors`
    and its `updated` event do. Main pushes `window:system-dark-changed`; `boot()` reads the
    initial value before the first render so a light OS does not flash the dark theme.
  - The accent is applied over the theme tokens by `themedTokens`, and extension panels get the
    same tokens (`--pine-brand`, `--pine-on-brand`). A color that reads under 4.5:1 on the theme
    background is moved toward black or white until it does. `themedTokens` always adds
    `on-brand` (`readableOn`), the text color for brand fills, and `index.css` points
    `--primary-foreground` and `--sidebar-primary-foreground` at `--color-on-brand`. Why: the
    shadcn foregrounds used to be the theme background, overridden inline only for a custom
    accent, so the sidebar variant kept the background color and a theme brand never got a
    contrast check. One computed token keeps every brand fill readable for any theme and accent.
  - Zoom is `window:set-zoom` (clamped to 80 to 150 in main, per sender). The terminal re-fits
    through its existing debounced `ResizeObserver` (the CSS viewport changes with the zoom), so
    the prompt-aware resize path in §6 is the only code that resizes the pty; there is no
    separate zoom fit. `e2e/appearance.spec.ts` covers the chords.
  - `notifications.command` runs from `record()` in `main/notify.ts`, so it fires for every
    recorded notification (terminal, agent and extension), even with desktop banners off. Like
    `behavior.externalEditor` it is split into argv first and substituted per argument with
    `shell: false`, and `settings.set` refuses it (directly or through `notifications`).
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
  - Main's `will-attach-webview` rejects any partition not starting with `pine-browser` (or an
    extension panel partition whose src the host allows, §11) and forces no preload, no
    nodeIntegration, contextIsolation and sandbox.
  - `browser:register` requires that the sender owns the pane and that the webContents is a
    `webview` guest hosted by that sender. Why: otherwise a renderer could register Pine's own
    webContents and drive it with `browse.eval`.
- **Automation** (`main/browse.ts`, `cli/browse.ts` + `cli/browseArgs.ts`,
  `shared/browseRuntime.ts`, `shared/browseSnapshot.ts`, `shared/browseInput.ts`): `pine browse`
  follows vercel-labs/agent-browser's command contract (verb names, argument shapes, the
  `snapshot` + `@eN` ref model, `--json` as `{success, data, error}`, `batch`), driving Pine's
  own browser panes. Every `browse.*` method needs the elevated `browse` cap.
  - **Target**: an explicit pane id (`--pane`) is an external id, and driving another
    workspace's pane also needs `all-workspaces`. With no pane id, the caller's active tab is used
    (set by `open`, `tab new`, `tab <id>`, `click --new-tab`; only honored inside the caller's
    workspace), else the first browser pane in the caller's workspace. `open` with no browser pane
    creates one and waits (≤ 10 s) for it to register so it can return its `tabId`. Tab ids are
    pane external ids.
  - **Page runtime**: element work runs in `browseRuntime(window)`, one self-contained function
    shipped with `toString()` into `executeJavaScriptInIsolatedWorld(BROWSE_WORLD_ID, …)`
    (`main/browseWorld.ts`). Why: in the page's main world the page could read or rewrite the
    ref table and fake what the agent sees; the isolated world shares the DOM and storage but not
    JS globals. The runtime is unit-tested in jsdom. Only `eval`, `wait --fn`, `pushstate`, the
    dialog override and `react-grab` run in the main world, because they need page globals.
  - **Snapshot**: the runtime walks the DOM (shadow roots, same-origin iframes inlined, hidden
    and `aria-hidden` subtrees skipped) into role/name/state nodes, with implicit ARIA roles and a
    simplified accessible name; main formats it (`formatSnapshot`: `-i` interactive only, `-c`
    compact, `-d` depth, `-u` urls) as `- role "name" [ref=eN] [level=1]` lines. Refs are kept per
    element in a `WeakMap`, so a surviving element keeps its ref across snapshots; a navigation
    resets the isolated world and every ref. Password values are never printed.
  - **Input**: `click`, `dblclick`, `hover`, `drag` and `mouse` are real `sendInputEvent` mouse
    events at the element's center (CSS px × zoom factor, same-origin iframe offsets added). Why:
    trusted events, `:hover` and React handlers behave as for a human. Before a click the runtime
    scrolls the element in if needed and fails with `covered by <tag#id.class>` when another
    element is on top (agent-browser's behavior). `type` and `keyboard type` send key events per
    character; `press` takes combos (`Control+a`, `parseKeyCombo`); `fill` sets the value through
    the native setter and fires `input`/`change`; `check`/`uncheck` click only when the state
    differs, then verify it.
  - **CDP** (the debugger attached at instrumentation): init scripts (`addinitscript` /
    `removeinitscript`, the dialog override, the error catcher), `upload` (the runtime marks the
    input, then `DOM.performSearch` + `DOM.setFileInputFiles`), full-page `screenshot --full`,
    `set viewport|media|offline|headers|geo`, and `network route|unroute` through the `Fetch`
    domain (abort with `BlockedByClient`, or fulfill a `--body`). `network requests` reads the
    per-guest request log `guestNetwork.ts` keeps from `Network.*` events (500 entries), which
    also backs `wait --load networkidle` (no pending request for 500 ms).
  - **Security**: agent strings reach generated JS only as `JSON.stringify`-ed arguments.
    `screenshot`, `pdf`, `state`, `upload` and `wait --download` paths go through `resolveSafe`
    (the CLI resolves them against its cwd first). The CLI reads stdin only for `eval --stdin`
    and for `batch` without arguments.
  - **Gotchas**:
    - Chrome allows one debugger per guest, so CDP features and the error catcher stop if
      DevTools (`inspect`) is open on that pane.
    - `<webview>` can't intercept synchronous dialogs, so `alert/confirm/prompt` are replaced and
      follow a standing accept/dismiss policy that resets to dismiss on every navigation;
      `dialog status` shows the policy and the log.
    - After input events the handler waits ~30 ms and a JS round trip before answering, so the
      next command sees the page after the input.
    - Default wait timeout 25 s (agent-browser's), capped at 120 s.
  - **Not carried over from agent-browser**: browser launch/session/profile/CDP-connect flags
    (Pine owns the browser), `clipboard` (the human's clipboard), `diff`, `trace`, `profiler`,
    `record`, HAR, `react`/`vitals`/`a11y`, `screenshot --annotate`, `set device|credentials`,
    `window new`, tab labels, `read <url>` and state files beyond `state save|load`.
- **Storage viewer** (`components/BrowserStoragePanel.tsx`, `main/browserStorage.ts`,
  `shared/browserStorage.ts`): the toolbar's storage toggle opens a drawer under the page with
  Cookies / Local storage / Session storage tabs, a filter, refresh, copy, edit, delete and a
  confirmed clear-all. Cookies are the pane's whole partition jar (`session.cookies`); web
  storage is the top page's origin, read and written through the same isolated browse world.
  The `browser:storage-*` IPC serves only a pane the sending window owns (`ownedGuest`) and
  validates every edit in main (`normalizeStorageEdit` / `normalizeStorageRemoval`: kinds, key
  ≤ 4 KiB, value ≤ 5 MiB, cookie domain/path). A host-only cookie is written back without a
  domain so it stays host-only. The drawer re-reads on every main-frame navigation. Agent
  `cookies` / `storage` verbs share these main functions.
- **Pick element** (`main/browsePick.ts`, `shared/pickRuntime.ts`, `shared/pick.ts`,
  `components/BrowserView.tsx` + `PickSendPanel.tsx`, `lib/sendPick.ts`):
  - The inspector is one self-contained function, `pickRuntime(window)`, serialized with
    `toString()` and run with `executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, …)`. Why: the
    isolated world shares the DOM but not JS globals, so the page can't read, patch or call it,
    and it sees no Pine token or IPC (guests have no preload). The same function is unit-tested in
    jsdom, and a test runs the serialized string to prove it has no outside references.
  - Hover draws a box + label in a closed shadow root on a `pointer-events: none` host; click
    (capture phase, default prevented) resolves the promise `start()` returned; Escape resolves
    null. Only `isTrusted` events count, so page scripts can't fake a pick or a cancel.
  - Main owns the pick: one per pane (`busy` otherwise), ended by cancel, timeout, main-frame
    navigation, guest destruction, or (for `browse.pick`) the CLI connection closing. It
    broadcasts `browser:pick-state` so the toolbar toggle and hint follow agent-started picks.
  - The capture is normalized and truncated in main (`normalizeCapture`: html ≤ 2 KB, style
    whitelist, last 20 console errors and failed requests). The element screenshot is
    `capturePage(rect)` with the CSS box clipped to the viewport and scaled by the zoom factor,
    saved in `privateTmpDir('pine-reports')`.
  - The renderer only gets a capture id back to send with. `browser:pick-send` checks the sender
    owns the source pane and that the capture came from it, writes `ui-issue-N.md` (mode 0600,
    `wx`, never overwritten), and posts a JSON `ui-issue` bus message from the browser pane's
    identity to the target. The renderer then pastes `@<path> ` (bracketed paste, no Enter) when
    the target is at an idle shell prompt or its running agent reported `waiting`/`done`
    (`canInsertReference`); otherwise the path goes to the clipboard. The target's attention is
    set to `working`, which never rings.
  - Failed requests come from CDP `Network.*` events on the debugger already attached for the
    error catcher (`guestNetwork.ts`); like the catcher, they stop if DevTools takes the debugger.
  - The overlay takes theme colors from the renderer on every user pick; agent picks reuse the
    last ones (Adeberry until the user has picked once).
  - Iframes aren't inspected: events inside a child frame don't reach the top window.
- **Your real Chrome**: Pine doesn't speak CDP to it; `docs/CHROME.md` pairs agents with Chrome
  DevTools MCP.
  - **Limits**: console and errors 500 each, dialogs 200, network log 500, snapshot 3000 nodes,
    names 200 characters.

## 10. Testing and packaging

- Test layout and house rules: CLAUDE.md §7.
- E2E runs the built app serially (`workers: 1`) because each instance owns a pty set and a
  per-PID socket. Every launch spreads `isolatedLaunch()` (`e2e/dataHome.ts`) to get a throwaway
  `XDG_DATA_HOME` and `--user-data-dir`. The app boots with no workspaces, so a spec that needs a
  terminal calls `openWorkspace(win)` (`e2e/helpers.ts`), which clicks the empty state's "New
  workspace" button and waits for the prompt. `workspace-restore.spec.ts` shares one data home across
  two launches and quits through `app.quit()` so `before-quit` runs. Its resize case relaunches at
  another window size with an 8 px terminal font (seeded `settings.json`) so the whole restored
  screen, including the user's p10k startup output, fits in the rendered rows it reads.
- `pnpm install:local` runs `pnpm package` (electron-builder → `dist/linux-unpacked`), then
  `scripts/install-linux.sh`. The script copies the build to `~/.local/share/pine/app` and writes
  `~/.local/share/applications/pine.desktop`.

## 11. Extensions

The extension host is how features live outside core. Design and the reasoning for choosing it
over in-process JS extensions: `docs/ROADMAP.md` §2. Authoring guide: `docs/EXTENSIONS.md`.

**Discovery** (`extensionManifest.ts`). Every subdirectory of a root that has a `pine.json` is a
candidate. Roots: the built-in dir, then the user dir. The manifest is validated strictly (id
slug, known capabilities, `main` and file-panel paths must resolve inside the extension dir,
anything with commands/sidebar items/url panel needs `main`; `contributes.workflows` are checked
with the same `parseWorkflow` as workflow files and need no `main`). A broken manifest is logged and
skipped without affecting the others. A user extension reusing a built-in id is rejected.
Discovery runs at startup and again whenever the user extensions directory changes
(`watchUserExtensions`: `fs.watch` on the root and each of its subdirectories, 250 ms debounce,
then `rescan`). A new id gets a fresh runtime (a user extension is `pending-approval`, so the
approval dialog appears on its own); a removed or now-invalid one is stopped and dropped with its
sidebar items and chips; a changed manifest (compared as JSON with its dir) is stopped and
swapped in, and restarted after its old process exits if it was running. Why each subdirectory
too: on Linux a watch on the root sees `mkdir hello` but not `hello/pine.json` being written, so
an extension copied in file by file would stay invisible. Why approval still holds: `rescan`
never touches `extensions.json`; granted caps stay manifest ∩ approved, so a manifest edited to
ask for more gets nothing new until the human reviews it.

**Approval** (`extensionStore.ts`, `userData/extensions.json`).
- Granted caps = manifest `capabilities` ∩ the human's approved list. Built-ins are pre-approved
  and enabled by default; user extensions start `pending-approval` and don't load until the
  approval dialog (`ExtensionApprovalDialog`) or Settings says so.
- "Keep disabled" records an empty approval so the dialog doesn't come back every launch.
- A later version asking for more caps runs with the old subset and Settings shows the rest as
  "not approved" with a Review button.
- Why a main-owned file, not `settings.json`: `settings set` is reachable from agents; this file
  has no socket method at all.

**Identity.** Each start mints a fresh identity with `kind: 'extension'`
(`idRegistry.registerExtension`), caps set explicitly with `setCaps`. The process gets
`PINE_SOCKET`, `PINE_TOKEN`, `PINE_EXTENSION_ID`, `PINE_EXTENSION_DIR`, `PINE_EXTENSION_DATA`
(`<userData>/extension-data/<id>`, its own state folder, created by the extension) and none of the pane
variables. `controlServer` checks the caller kind per method (`callers: 'panes' | 'extensions' |
'all'`): extension identities can call `hello`, `whoami` and the extension-only `ext.*` methods;
panes can call everything else including `ext.list` / `ext.invoke`. Why: pane methods resolve
"self" from a pane id, and an extension has none; letting it through would make `command.exec`
target whichever window happened to be first.

**Targetable methods** (`registerTargetableMethod`: every `browse.*` in `browse.ts`, every
`process.*`, `pane.setAttention`). An extension may call them only with `targetPaneId` (an
external pane id); `controlServer` then requires the method's own capability **and**
`all-workspaces` from the extension's granted caps, strips `targetPaneId`, and runs the handler
with the target pane's identity as "self" (window, workspace, pane) while capability checks still
use the extension's connection. A missing target is `needs-target`, a non-pane id
`unknown-target`. Pane callers are unchanged. Why `all-workspaces`: an extension owns no pane, so
every pane is "another" pane, and acting on another pane has always needed `all-workspaces`;
reusing it keeps the capability model as it was and still needs the human's approval in the
manifest. Why act as the target instead of adding extension variants: the handlers already
resolve everything from "self", so the default browser pane, the process's workspace and the
attention target all follow the pane the extension named. `browsePick.ts` is not targetable: pick
waits on the human's click and pastes into an agent pane.

**Processes** (`extensionHost.ts`).
- `main` ending in `.js/.cjs/.mjs` runs with the app's Electron binary and
  `ELECTRON_RUN_AS_NODE=1` (like the `pine` CLI), anything else is executed directly; cwd is the
  extension dir.
- Lazy start: the first invoke, panel resolution, or (for extensions with `sidebarItems`) window
  creation. A command waits until the process has registered it (`ext.registerCommands`), 10 s max.
- An `ext.command` request times out after 30 s (`REQUEST_TIMEOUT_MS`), or 10 min
  (`INTERACTIVE_TIMEOUT_MS`) for a command whose manifest says `interactive: true`. Why: an
  interactive command waits on the human (`ext.confirm`), who may take longer than 30 s; before
  this the CLI got `extension-unavailable` while the dialog was still open. The CLI itself has no
  timeout, so it waits as long as the host does. A human who answers after the 10 min still gets
  what they chose (the extension finishes the work); only the agent's answer is lost.
- A failed result may carry `data` (`{ok: false, error, message?, data?}`); the CLI prints it on
  stdout as JSON before the error line and exits 1. Why: `pine system install` must tell the agent
  `{approved: false, command}` and still fail.
- On exit the identity is revoked, the server-side connection is disposed (which rejects any
  in-flight request immediately rather than at the 30 s timeout), subscriptions, sidebar items
  and pane chips are dropped, and the process is restarted after 500 ms · 2ⁿ, at most 3 times;
  then the status is `crashed` until the user disables and re-enables it.
- Stopping (disable, removal, a changed manifest) revokes the identity and disposes the
  connection at once, before SIGTERM. Enabling it again while the old process is still exiting
  marks it `restartAfterExit`, and `onExit` starts the new process. Why: until the exit event the
  runtime still held the dying connection, so an invoke right after off → on was sent to it and
  failed with "connection got disposed".
- `before-quit` sends SIGTERM to every extension process.

**Methods.** Extension → pine: `ext.registerCommands`, `ext.subscribe`, `ext.setSidebarItem`,
`ext.setPaneChip`, `ext.clearPaneChip`, `ext.getSettings`, `ext.setSetting`,
`ext.notify` (needs `notify`), `ext.openPanel`, `ext.openDiff`, `ext.confirm`, `ext.openTerminal`
(needs `shell`), the targetable pane methods above, plus the shared
read methods `workspace.list` / `pane.list` (`callers: 'all'`, need `read-board`). Pine → extension:
`ext.command` and `ext.panel` requests, `ext.event` notifications. Pane → pine: `ext.list`,
`ext.invoke`.
- `ext.openDiff` validates (title, both sides strings ≤ 5 MiB, absolute `path`) and main sends
  `extensions:open-diff` to the workspace's window, where `openExtensionDiff` opens the diff pane
  (§5, §9). Why a generic diff and not a git view: the first consumer is git, but a diff of two
  texts is what any VCS, formatter or code-review extension needs, and core stays VCS-agnostic.
- `ext.openTerminal {command: string[], workspaceId?, afterPaneId?, cwd?, title?}` opens a new
  terminal pane and runs the argv there once. Main validates (1–64 strings, ≤ 4096 chars each, no
  control characters, a non-empty program; `cwd` absolute; `afterPaneId` an external pane id in
  `workspaceId` if both are given), resolves `afterPaneId` to the renderer pane id and window,
  quotes the argv for a POSIX shell (`shared/shellQuote.ts`: bare word if it is only
  `[A-Za-z0-9@%+:,./_-]`, else single quotes) and sends `extensions:open-terminal` to that window.
  `openExtensionTerminal` splits right of `afterPaneId` (else the active pane; an empty workspace
  gets it as its first pane), activates that workspace, and `runWhenIdle` (`lib/blockActions.ts`)
  pastes the line with Enter through `insertCommand` once the new shell has drawn its first
  prompt (OSC 133 A and B, nothing running), then unsubscribes; it gives up after 30 s. The
  renderer answers with the new pane id (`extensions:open-terminal-result`), which main registers
  and returns as the external id. Why a new pane and never an existing one: the only pane an
  extension may type into is one nobody else is using, so the invariant "nothing types into a
  pane unless it's at an idle prompt" holds without trusting the extension about any other pane.
  Why argv and quoting in main: an extension hands data, never a shell string, so a package name
  like `$(rm -rf ~)` stays one literal argument. Why wait for B and not only A: A is sent before the
  prompt is drawn, B once it is on screen and the shell is about to read input.
- The caller context carries `locale` for pane callers too (the app's `settings.json` locale,
  `readLocale` in main), so a dialog an agent triggers is in the human's language.
- `workspace.list` includes `activePaneId` (external id) so an extension can follow "the pane the
  user is in" without a pane-scoped method.
- The caller context carries `cwd`: for a pane caller the pane's live terminal cwd
  (`cwdForPane`, from `terminal:state`), for a palette call the active pane's.
- `ext.confirm {title, message, detail?, confirmLabel?, cancelLabel?}` shows a native question
  box on the focused window (`extensionConfirm.ts`), always naming the extension, Cancel as the
  default; it resolves `{confirmed}`. Why a dialog in main rather than in the panel: the action
  may come from the palette or an agent's `pine` call with no panel open, and a confirm the
  extension draws itself proves nothing about the human.
- `ext.notify {…, openPanel: true | path}` (extensions with a panel) records the notification
  with the extension's id (`NotificationEntry.extId`); clicking it, on the desktop or in the
  notification center, opens that extension's panel (at `path` if given) instead of jumping to a
  pane. The notification-center entry keeps that path (`NotificationEntry.panelPath`), so a
  click in the bell opens the same page as a click on the desktop notice; the renderer hands it
  back through `openExtensionPanel`, and main checks it again in `resolvePanel`.
- Pane chips: `contributes.paneChips` declares up to 8 `{id, title}`; `ext.setPaneChip {paneId,
  id, text, tooltip?, tone?, command?, url?}` resolves the external pane id to the renderer pane id,
  keys the value by (extension, pane, chip), clips text to 40 and tooltip to 200 characters, and
  accepts `command` only if it is one of the extension's own palette commands. Empty text or
  `ext.clearPaneChip` removes it; `pane-closed` (`clearPaneChips`) and the extension stopping
  remove all of theirs. Main pushes the whole list on `extensions:chips`; the renderer keeps it in
  `extensionsStore.chips`. Why no capability: a chip is display on a pane like a sidebar item on
  a workspace, and it can only run a command the extension already offers in the palette, through
  the palette path with the human's click. A chip may instead carry a `url` (http/https,
  `sidebarItemUrl`; never together with `command`): a click opens it in the browser pane of the
  chip's pane's workspace (`paneChipAction` → `openSidebarUrl`), in the header and in the Pine
  prompt's chip row alike. Why a URL and not `browse.open` from the extension: opening a page is
  the human's click, and a link needs neither `browse` nor `all-workspaces` (the ports chip).
- Command arguments: a manifest command may declare `argument` (a label, 80 chars). The palette
  then shows a second step with that label as the input's placeholder; Enter runs the command
  with `{argument}`, and `extensions:invoke` passes it on as `{argv: [value]}` only if the command
  declares an argument and the value passes `commandArgument` (trimmed, 1–1000 chars, no control
  characters, `ExtensionHost.paletteArgs`). Otherwise palette commands still get `null` args. Why
  one value as `argv[0]`: the extension parses it exactly like `pine <ext> <command> <value>`, so
  one handler serves the palette and the CLI, and there is no form language to maintain.
- Settings: `contributes.settings` maps keys to `{type: string|number|boolean|enum, default,
  description, values?}` (32 max; the default must match the type). Main keeps the stored values
  (`extensionSettings` in `settings.json`, read at start and again when sync pulls
  `settings.json`), validates every change from Settings → Plugins (`extensions:set-setting`,
  `null` resets a key), answers `ext.getSettings` with defaults + valid stored values, and sends
  `ext.event {type: 'settings.changed', payload: {values}}` to a running extension when its values
  change. The renderer persists what main returned (`setExtensionSettings`) with the rest of
  `settings.json`. Why main validates while the renderer writes: the renderer owns the file (it
  rewrites it whole), and an extension must never see a value its manifest didn't allow; stored
  values of the wrong type fall back to the default instead of failing. `extensionSettings` is not
  in the settings store's `DATA_KEYS`, so `pine settings set` can't change it. An extension may
  change its own keys with `ext.setSetting` (`setOwnSetting`: the same `setSetting` validation,
  scoped to the caller's own manifest); main then broadcasts `extensions:settings-stored
  {extId, stored}` and the renderer persists it like a change from Settings. Why: a panel control
  that mirrors a setting (Git's graph scope, flat/tree view) must land in the same place the
  Settings page edits, or the two drift. Extension settings are preferences, never grants, so
  this gives an extension nothing it couldn't already do.
- Command caps declared in the manifest are checked against the caller before the process is
  even started. The extension receives the caller context (`kind`, external `paneId`,
  `workspaceId`, `workDir`, `capabilities`) and may enforce conditional rules itself (for example
  requiring `all-workspaces` for writes outside the workspace's project).
- Events are derived in main: `pane.created/closed` from lifecycle IPC, `cwd.changed` and
  `command.started/finished` from `terminal:state` diffs (running flips, last exit code),
  `focus.changed` from `browser-window-focus/blur`, `notification` from the `notify` platform
  event. Subscribing to pane/command/cwd/focus events needs `read-board`; `notification` needs
  `notify`.
- Sidebar items are keyed by (extension, workspace, key), capped at 32 per extension and 80
  characters, and rendered in the workspace row or the sidebar footer (no workspace). An item
  may carry a `url` (http/https only, `sidebarItemUrl`); the rail renders it as a link button
  that switches to the item's workspace and opens the URL in its browser pane (`openSidebarUrl`,
  reusing the workspace's browser pane if it has one). Why a URL and not an extension command:
  opening a page needs no round trip, and an extension still can't drive the browser.
- `pane.list` gives terminal panes with a live pty their shell `pid`. Why: the process tree
  below it is how an extension learns what a pane is running (ports, ssh) without a core view.
  A file view (`kind: 'editor'`) carries its `filePath`. Why: a palette command's caller names
  the focused pane, and without the path an extension can't act on "the open file" (git blame).

**Panels.** `ExtensionPanelView` asks main for the source (`extensions:panel`):
- file entry: `file://` URL of the html inside the extension dir;
- `url` entry: main asks the process (`ext.panel` with a user caller carrying workspace, workDir,
  locale) and accepts only an `http://127.0.0.1|localhost` URL, remembering its origin.
The webview uses partition `pine-ext-<id>`, and `will-attach-webview` refuses it unless the src
passes `isAllowedPanelUrl`. The guest gets the same hardening as browser panes (no preload, no
node, sandbox, context isolation) plus: permission requests denied, `window.open` routed to
`openExternalSafe`, and navigations/redirects outside the allowed file dir / origin blocked. The
renderer injects the theme into the guest as `--pine-*` custom properties (`lib/panelTheme.ts`),
plus `--pine-motion-scale` from `useReducedMotion`. Why a scale and not a media query: the
guest sees only the OS `prefers-reduced-motion`, not `appearance.motion`, and `insertCSS` only
adds rules, so the value is re-sent as `0` or `1` on every change instead of being left out.
Why panels talk only to their own process: the guest has no `window.pine` and no token, so a
compromised or buggy panel can do no more than its extension already can.

Panel paths: `ext.openPanel {path}` and a notification with `openPanel: path` send the path to the
renderer; `openExtensionPanel` focuses the extension's panel pane in that workspace (or opens it)
and records `panelNav[paneId] = {path, seq}`. `ExtensionPanelView` re-resolves its source with
the path and, if a page is already showing, keeps the webview and only changes its `src`, so the
panel navigates instead of opening a second one. A path must start with one `/` and contain no
whitespace, control characters or backslashes (`panelPath`). For a file panel main maps it into
the extension dir (percent-decoded, query and hash kept); for a `url` panel it passes `path` to
the process in `ext.panel` so the extension can build the URL with its own secret. Either way the
result must pass `isAllowedPanelUrl` before it is returned. Why re-check in main: setting a
webview's `src` does not fire `will-navigate`, so the attach-time check is the only other guard.

**Assist** (`shared/assist.ts`, `ExtensionHost.assist*`, `main/assistIpc.ts`). Five hook points an
extension can serve: `input` (typo fix and prompt review of a draft for an agent), `command`
(natural language to shell command suggestions), `completion` (inline code completion in the
editor), `terminal` (ghost text continuing the command at a shell prompt) and `chat` (the chat
pane and the palette's Ask). The core UI for each is tool-agnostic; the
extension owns providers, prompts and requests.
- Declared by `contributes.assist` and gated by the `assist` capability (the manifest is rejected
  without it; the host routes only to an extension whose granted caps include it). An extension
  that contributes assist starts with the window, like one with sidebar items, so it can report
  `ext.setAssistStatus {status: {<point>: {ready, label?}}}` (needs `assist`). Only points that are
  contributed and `ready` count; `assistAvailability()` names the first such extension per point
  (built-ins first) with its label, and main pushes it on `assist:availability` whenever the
  extension list or a status changes and drops it when the extension stops. Why a status the
  extension reports instead of "has a manifest entry": the built-in assistant is installed and
  enabled for everyone but must stay invisible until the human configures a provider.
- `assist:request (point, requestId, input)` normalizes the input in main
  (`normalizeAssistRequest`: known fields only, size caps, a chat must end with a user turn or
  a tool turn whose calls all have outcomes,
  context kinds from a fixed list) before anything reaches the extension, then sends
  `ext.assist {point, requestId, input}` with a jsonrpc cancellation token. The reply is
  normalized again (`normalizeAssistResult`), or mapped to a typed failure when it is
  `{error: <AssistError>, message?}` (the SDK turns an `AssistFailure` thrown in the handler into
  that). Timeouts: 30 s, 5 min for chat.
- Streaming: the extension calls `ext.assistChunk {requestId, text}` (needs `assist`) for each
  delta; main forwards it on `assist:chunk` to the window that asked and answers `{live}` so the
  extension stops producing once the request is gone. Chunks are capped (256 KiB each, 1M
  characters per request; a JSON chunk that doesn't fit is dropped whole rather than cut). Why chunk requests rather than notifications: the control server only
  dispatches requests, and a request gives the extension backpressure for free.
- Cancellation: `assist:cancel (requestId)` from the renderer (Stop, a closed palette, a newer
  keystroke) cancels the token; main answers `cancelled` at once without waiting for the
  extension, and the SDK hands the handler an aborted `AbortSignal`. A window that closes cancels
  everything it left running. At most 8 requests per window run at once (`busy`); debouncing is
  the renderer's job, rate limiting the extension's.
- What reaches the extension is only what the human's action put in the request: the draft they
  typed in the composer, the words after `# ` in the input editor, the code around the cursor of
  the file they are editing, and in Ask only the context chips they switched on (recent output,
  selection, folder, pane chips) or the failed block they asked to explain.
- Renderer: `stores/assistStore.ts` keeps the availability and wraps a request (`assistRequest`:
  a fresh request id, chunks filtered by id, an `AbortSignal` that sends `assist:cancel`).
  `AssistComposer.tsx` (chord `assist.compose`) sits over the bottom of a terminal pane without
  resizing it: over a running agent it debounces typo requests (700 ms), shows the fix as a
  word diff applied only on Tab, reviews on Ctrl/⌘+Enter, and pastes the draft through
  `canInsertReference` without Enter; at an idle shell prompt it lists command suggestions and
  inserts the pick with `insertCommand` without Enter. `InputEditor.tsx` asks `command` for a
  `# ` draft (600 ms) and replaces the draft only on Tab/Enter. `monaco/inlineAssist.ts` is one
  inline-completions provider for every language (300 ms debounce, Monaco's cancellation token
  wired to the request) that answers nothing while no `completion` provider is ready.
- Terminal ghost text (`lib/terminalGhost.ts`, `InputEditor.tsx`): `pickGhost` decides what shows
  — nothing during IME, vim normal mode, the completion menu, the `# ` hint, history walking, a
  selection or a caret before the end; else a history prefix match; else the AI continuation
  while the draft is still a prefix of it. Requests go 300 ms after typing stops, each keystroke
  aborts the previous one, answers are cached per exact line; the request carries the cwd,
  platform, the pane's last 5 commands with exit codes and its pane chip values, never output.
  Tab accepts an AI ghost (else Tab completes as before), → / End accept either.
- Chat (`ChatView.tsx`, `ChatPane.tsx`, `stores/chatStore.ts`, `lib/chatTransport.ts`): the
  `chat` pane surface and the palette's Ask render one `Chat` (`@ai-sdk/react`) per session with
  Vercel AI Elements components adapted to Base UI (markdown stays react-markdown + remark-gfm
  with Typeset, code colouring is Monaco's `colorize`). The transport turns the extension's
  JSON `UIMessageChunk`s into the stream `useChat` reads. Why chunks rather than text: tool calls
  and results arrive as parts of the same stream, so tools can be added without a new protocol.
  A chat pane persists only its session id; the session itself is in main (below). Code-block
  actions (`lib/chatActions.ts`) follow §4's typing rules; links in answers go through
  `lib/chatLinks.ts` (`findFileLinks`); the @ picker attaches files (confined `fs.read`, capped),
  the selection, a block's output or a browser page as context chips that show what is sent.
- Slash commands (`lib/chatSlash.ts`, `ChatSlashMenu.tsx`): a `/` at the start of the draft
  opens a cmdk list above the composer, at the caret's column (`lib/caretPoint.ts`), driven from
  the textarea like the input editor's completion menu (controlled `value`, `aria-activedescendant`
  synced from cmdk's selected item). The registry is a data table (`id`, `icon`, `arg`,
  `unavailable(ctx)`, `run(actions, arg, ctx)`); titles, descriptions and reasons live in
  `chatSlash` in the dictionary. Commands run in the renderer and call the same functions as the
  buttons they stand for (new chat, session list, rename, export, regenerate, the @ picker, the
  tools menu); a draft whose first word is a known command never reaches the model. Only
  `/explain` (the terminal selection, the selected block or the last output, as the human picks,
  sent like the Explain output suggestion) and `/skill` (asks the model to `load_skill`) build an
  ordinary question. Why a registry of local actions rather than prompt templates: a command
  must not send anything the human didn't put in the question (§4 assist rule), and nothing it
  does may type into a terminal; answers still go through the code-block rules. `/clear` asks
  first and deletes the saved copy too (`clearSession`), since an empty chat is never saved.
- The extension runs its providers on the AI SDK: `streamText(...).toUIMessageStream()` for
  chat, `generateText` with `Output.object` + zod (behind `extractJsonMiddleware`) for review and
  commands, and `createOpenAICompatible` with an undici `fetch` over the unix socket plus
  `simulateStreamingMiddleware` for model-runtime, which refuses `stream: true`. Why undici 6:
  extensions run on Electron 33's Node 20, and undici 8 needs Node 22.

**Feature switches and setup state.** `ext.setAssistStatus` also carries the extension's feature
list (`{id, setting, ready}`, ids from `ASSIST_FEATURES`), a setup problem, the last provider
error and a label. Main keeps only features bound to one of the extension's own boolean settings
and reads `on` from that setting (`assistOverview`, pushed on `assist:overview`), so the top-bar
menu, the in-context switches and Settings → Assistant all flip the same value through the
validated setting path. Why the extension names the setting: pine must stay
tool-agnostic, and a switch that isn't a real setting would drift from Settings. `ext.shortcuts`
answers the effective key labels the renderer reports (`assist:shortcuts`), and `ext.openAssistUi`
opens pine's chat pane, Ask or composer for a point the extension contributes, never sending
anything by itself.

**Settings → Assistant** (`AssistantSection.tsx`). The assistant is configured in its own
Settings section, not under Plugins (Plugins keeps only its switch and a link): Features (status,
each feature's switch, shortcut hint and "Try it", which calls `openAssistUi` directly; chat
history), Provider and models (the extension's own `contributes.settings` and secrets through
`ExtensionSettingsForm`, minus the feature switches, so main still validates and stores them),
Models, then the core chat tools, MCP servers and skill folders (`ChatToolsSettings.tsx`,
`McpServerDialog.tsx`, pure form logic in `lib/mcpServerForm.ts`). Models come from the
extension through `ext.assistModels` (`list`, `load`, `unload`), asked by main only for an
enabled extension granted `assist` whose report said `models: true` (`assist:models`,
`assist:set-model-loaded`), with replies normalized by `normalizeAssistModels`. Why not the
extension's panel: chat tools run in core, and one settings page for the whole assistant reads
as part of Pine rather than a plugin's own UI; the assistant extension no longer has a panel.

**Chat sessions** (`main/chatSessions.ts`, `chatSessionsIpc.ts`, `shared/chatSessions.ts`). One
JSON file per session in `<data dir>/chat-sessions/` (mode 0600, never synced, not
`settings.json`): title, workspace id, model label, created/updated times and messages shaped
like the AI SDK's `UIMessage` (role + typed parts + metadata with the context items that were
sent). Parts other than text are kept as bounded JSON so tool calls and results can be added
later without reshaping. Each save is normalized in main, trimmed from the oldest turn when the
session passes 512 KiB (`trimmed`), and the least recently updated other sessions are evicted
past 16 MiB or 500 sessions; the result tells the renderer what was dropped so it can say so.
Export writes markdown through a save dialog in main; "Save as file…" does the same for a code
block. Why main writes them: the renderer has no fs access outside the confined `fs:*`, and a
session holds terminal output the human chose to send, which belongs in the private data dir.
Tool calls are stored as the AI SDK's `dynamic-tool` parts (input, output or error, the approval
and its answer, `output-denied` for a denial); a tool part past the 64 KiB part cap is kept with
its strings clipped (`…[truncated]`) rather than dropped, and export writes each call, its result,
error or denial in order with the text around it.

**Chat tools** (`lib/chatTools.ts`, `lib/chatToolPermissions.ts`, `stores/chatToolsStore.ts`,
`lib/chatTransport.ts`; `main/chatFsTools.ts`, `chatSkills.ts`, `mcpHost.ts`, `chatToolsIpc.ts`;
`shared/chatTools.ts`). The assistant chat can call tools; the split is:
- The extension owns the model only. A chat request lists the tools core offers
  (`ChatToolSpec`: name, description, JSON schema) and assistant turns carry their calls with a
  `done`/`error`/`denied` outcome (`ChatToolCall`). The built-in assistant declares them to
  `streamText` as `dynamicTool`s without `execute`, so a step that calls a tool simply ends; it
  drops `tool-input-delta` chunks (the whole input comes in `tool-input-available`) and reports
  `tools: true` on its chat status. Why no execute in the extension: every tool acts through
  core (files, panes, the human's MCP servers), and an extension may only use the public API, so
  the extension gains no new power; a third-party chat extension that ignores `tools` keeps
  working as before.
- The renderer runs the loop inside the chat transport (`createAssistTransport`): it sends the
  request, collects the calls the model streamed, runs each one, emits the AI SDK chunks for it
  (`tool-approval-request`/`-response`, `tool-output-available`/`-error`/`-denied`) into the same
  assistant message, and asks again with the outcomes, at most `MAX_TOOL_ROUNDS` (8) per turn.
  Why the transport and not `useChat`'s `onToolCall` + `sendAutomaticallyWhen`: one stream per
  turn means Stop (the transport's `AbortSignal`) cancels the model, a waiting card and an
  in-flight MCP call together, and one `onFinish` saves the whole turn. Tool outputs of turns
  before the latest question go back to the model clipped to 2000 characters.
- Permission (`decideTool`, pure): `read` tools (read, list, search, terminal context, git
  status, load skill) run without asking inside the workspace folder (`workDir`); outside it they
  ask once per chat (`read-outside`). `act` tools (open a file, open a URL) and every MCP tool ask
  with Allow once / Allow for this chat / Deny. `confirm` tools ask every time with nothing to
  grant: `write_file` shows a diff (jsdiff) of what main previews, and `propose_command` offers
  Insert at prompt (`insertCommand` without Enter, else the clipboard) or Run in new terminal
  (`runInNewTerminal`, `runWhenIdle`, the risky-paste dialog for newlines or control characters).
  Grants live in memory per session and are never saved. Why no grant for writes and commands:
  each one differs, and the diff or the exact command is what the human is approving.
- Main does the fs work (`chatTools:read|list|search|preview|write`): paths are absolute (the
  renderer resolves them against the workspace folder), confined by `resolveSafe` and then by
  `realpath` to the fs roots (a symlink out of them is refused, unlike `fs:*`), and to the
  workspace folder unless the renderer passes `outside` after the human approved. Reads cap at
  4 MiB and 2000 lines / ~30k characters, refuse binary files; search walks up to 5000 files
  skipping `.git` and `node_modules`; writes cap at 1 MiB and refuse to write through a symlink.
- Skills: `assistant.skillFolders` (a folder with a `SKILL.md`, or a folder of them). Main reads
  them (`chatSkills.ts`): front matter `name`/`description` parsed with `yaml` (aliases refused),
  symlinked folders and files and files over 256 KiB skipped. The model sees only names and
  descriptions (in `load_skill`'s description) and loads a body with `load_skill`, read-only.
- MCP: `assistant.mcpServers` (`parseMcpServer`: a name, exactly one of an argv or an http(s)
  URL, env for argv servers, the names of secrets, disabled tool names). `McpHost` (main,
  `@ai-sdk/mcp`, bundled into main because it is ESM-only) connects a server only when a chat or
  Settings asks (`chatTools:mcp-refresh`), reconnects when its command, URL, env or set secrets
  change, and broadcasts status (`chatTools:mcp-status`). An argv server is spawned with
  `shell: false` in the home folder and gets only HOME, LOGNAME, PATH, SHELL, TERM and USER plus
  its env and secrets (so never `PINE_TOKEN`); secret values go in as env (argv) or headers
  (URL). Why main hosts the clients: the servers are programs the human configured, like
  `behavior.externalEditor`, and tool results must pass the same approval card whatever the chat
  provider. Secrets are stored with the extension-secret store's `safeStorage` code in their own
  `mcp-secrets.json` (never synced, never returned; `chatTools:set-mcp-secret` accepts only a key
  the human declared on that server). Tool names are `mcp__<server>__<tool>`; main re-checks that
  the server is enabled and the tool exists and is not switched off on every call.
- `assistant` is not in the settings store's `DATA_KEYS`, so `pine settings set` cannot add a
  server or a skill folder; Settings → Assistant writes them (and flushes the file
  before asking main to reconnect, since main reads `settings.json` itself).
- Why the assist reply now carries `chunks`: an `ipcRenderer.invoke` reply can overtake the
  `assist:chunk` events sent before it, and the last chunk of a round is often the tool call.
  `assistRequest` waits (up to 3 s) until it has seen as many chunks as main forwarded.

**Extension secrets** (`main/extensionSecrets.ts`). `contributes.secrets` declares up to 8 keys
with descriptions. Settings → Plugins shows a password field per key; `extensions:set-secret`
encrypts the value with `safeStorage` into `extension-secrets.json` in the data dir (mode 0600,
never synced, refused when encryption is unavailable). The renderer only learns which keys are
set (`ExtensionInfo.secretsSet`); the extension reads its own declared keys with
`ext.getSecret {key}`, and gets `settings.changed` when the human changes one so it re-reads it.
Why not a string setting: `extensionSettings` lives in `settings.json`, which the renderer
holds whole and settings sync copies to a folder the user shares.

**Git** (`src/extensions/git/`, the first built-in written for the API rather than migrated):
- Sidebar: per workspace, the repo of the workspace's active pane cwd (else the last active
  terminal's, else the first terminal's, else the workDir; `workspaces.ts`) gets one item:
  branch (or short sha when detached), `↑ahead ↓behind` when there is an upstream, `+new`
  (untracked or staged adds) and `~changed` (everything else), counted per path from
  `git status --porcelain=v2 --branch -z --untracked-files=all` (`status.ts`). Non-repo → no
  item. Refreshed 300 ms after `cwd.changed`, `command.finished`, `pane.created/closed`, and
  every `pollSeconds` (setting, default 10, clamped to 2..3600 by `readGitSettings`) only while
  a pine window is focused (`focus.changed`); a refresh in flight coalesces the next. Why the
  poll: edits by an editor or agent outside a terminal command fire no event. Why the cap: Node
  turns a `setInterval` delay above 2^31-1 ms into 1 ms, so an unbounded value meant nonstop git.
- Pane chips, in the same refresh: every terminal pane whose cwd is in a repo gets `branch`
  (`branchChipText`: branch or short sha, then `• ↑ahead ↓behind` against an upstream, counts
  capped at `999+`, Warp's branch status format) and `diff-stats` (`files • +added -removed` from
  `git -c diff.autoRefreshIndex=false diff --shortstat HEAD`, Warp's GitDiffStats source;
  hidden when clean or when the `showDiffStats` setting is off). Status and shortstat run once
  per distinct cwd/root per refresh, and a chip is sent only when its text changed. The branch
  chip carries `command: 'show'`, so clicking it opens the panel. Why `diff-stats` and not
  `diffStats`: pane chip ids share the command id pattern (lowercase and dashes). Why shortstat
  against `HEAD`: it counts staged and unstaged lines together and ignores untracked files, the
  same numbers Warp shows, and it costs one process per repo.
- Git runs with `GIT_OPTIONAL_LOCKS=0` so background status never takes the index lock from
  the user's own git commands.
- Diff sides: staged = `HEAD` vs index, unstaged = index vs working file, untracked = empty vs
  working file, conflicted = `HEAD` vs working file (with markers); blobs via `git cat-file blob`.
  Binary (NUL in the first 8000 bytes) and > 2 MiB sides are refused; a symlink shows its target
  path, never the file it points to.
- Commands: palette "Show Changes", "Show Graph" (`/graph`) and "Blame File" (`/blame?file=…`)
  open the panel (served from its process by `startPanelServer`; `ext.panel`'s path picks the
  page). "Blame File" finds the focused file view through `pane.list`'s `filePath` for the
  caller's pane and fails with `no-file` for anything else. The Changes page lists
  conflicts/staged/changes/untracked; a row click calls `open` (`ext.openDiff`), and per-row and
  per-section buttons stage (`git add -A`), unstage (`git reset -q HEAD`, or `git rm --cached`
  before the first commit) and discard. The commit box commits the index only (`git commit -q
  -m`) and shows git's own error text (stderr, else stdout: "nothing to commit" is on stdout).
  Changed files show as a flat list or a folder tree (`fileTree.ts` `buildFileTree`: folders
  first, file counts, and a chain of single-child folders compacted into one row like VS Code);
  a folder row's buttons stage, unstage or discard exactly the files under it.
  The Graph page (`graph` panel handler) reads `git log --date-order --decorate=full` with
  parents and refs (`%H %P %an %ae %at %D %s`, `parseGraphLog`) for the scope's revisions
  (`scope.ts` `planScope`: `HEAD`; `--branches --remotes HEAD`; or the chosen `refs/heads/*` /
  `refs/remotes/*` after `--end-of-options`, each checked against `git for-each-ref`, so no
  option reaches git). The panel lays the rows out itself with `layoutGraph` (`graph.ts`, pure):
  each lane waits for one sha; a commit takes the first lane waiting for it, every other lane
  waiting for it curves in, its first parent continues its lane (or curves into a lane already
  waiting for that parent), and each further parent curves into a lane that waits for it or a
  free one with a new color. Freed lanes are reused, so width stays at the number of live
  branches. Each row is one SVG (edges from the top edge to the node and from the node to the
  bottom edge, cubic curves with vertical tangents); colors are eight lane classes mixed from
  the group palette. HEAD's node is a ring, merges a smaller dot. When the tree is dirty a
  virtual first row ("Uncommitted changes", staged/unstaged/untracked/conflict counts) is laid
  out with `pending: true`: a dashed hollow node whose dashed edge runs to HEAD, which stays on
  its lane. Clicking it shows the changes with their stage/discard buttons; clicking a commit
  shows its files (`git diff --name-status -z -M` against the first parent, `diff-tree --root`
  for a root commit), and a file opens parent vs commit in the diff pane. The list is
  virtualized (fixed 24 px rows, only the visible rows plus overscan are in the DOM) and pages
  300 commits at a time up to 10,000 as you scroll; Up/Down/PageUp/PageDown/Home/End move the
  selection, Escape closes the detail. Why the layout runs in the panel: pages re-lay the whole
  loaded list, and shipping rows instead of commits would triple the payload.
  Scope and view are settings: `graphScope` (`current` | `all`, default `current`) and
  `changesView` (`list` | `tree`). The panel's own controls write them through `ext.setSetting`,
  and the extension re-reads them from `onSettingsChanged`, so the panel and Settings → Plugins
  stay in sync. "Choose branches" can't be a setting (it names one repository's refs), so it
  lives per repository root in `$PINE_EXTENSION_DATA/view.json` (`viewState.ts`, 200 repos),
  and wins over `graphScope` until the panel picks Current or All again. The toolbar shows the
  branch and its upstream with ahead/behind counts. The Blame page renders `git blame --porcelain` (`parseBlamePorcelain`), one
  author/sha/date cell per run of lines from the same commit. CLI/agents: `status`, `changes`,
  `diff <path> [--staged]` (unified patch), `open <path> [--staged]`, `log [--limit n] [--json]`,
  `blame <file> [--json]`, `stage|unstage <paths>|--all`, `commit -m <msg>`. A diff/open path
  must match a changed file (resolved from the caller's cwd, or repo-relative), so it can't be
  used to read arbitrary files; blame finds the repo from the file's own directory.
- Discard is a panel-only handler (`panelHandlers`), not a manifest command, so neither the
  palette nor `pine git` can reach it: it restores unstaged files from the index (`git checkout
  --`) and deletes untracked ones (`git clean -f --`), only after `ext.confirm` lists the files.
  Why: it destroys work that no commit holds, so only the human decides. Every path-taking call
  passes `--literal-pathspecs`, so a file name like `:(glob)*` is a name, never pathspec magic.

**Ports** (`src/extensions/ports/`). Every 3 s while a pine window is focused (and 400 ms after
pane and command events) it takes the `pid` of each terminal from `pane.list` and walks the
process tree below it. Linux: one pass over `/proc/*/stat` builds the ppid map; the tree's
`/proc/<pid>/fd` socket inodes are matched against the LISTEN rows of `/proc/net/tcp{,6}`.
macOS: `ps -axo pid=,ppid=,pgid=,tpgid=,comm=` and `lsof -nP -iTCP -sTCP:LISTEN -F pn` (argv,
no shell). Sockets that Pine's main process (the extension's parent) also holds are dropped,
because pty children inherit main's descriptors. Per workspace, up to 6 ports become `:port`
items with `url: http://localhost:<port>/`. A tree process named `ssh` in its terminal's
foreground process group (`pgrp == tpgid`) gives an `ssh` item with the destination host,
parsed from its argv (`sshLogin`: skips ssh's value options, keeps `-l user` / `user@` /
`ssh://user@`, handles `--`, refuses anything that isn't a plain host name, drops a user name
that isn't plain text, and shows nothing for `-G`/`-V`/`-Q`/`-O`); no network calls. Per
terminal pane it also sets two pane chips (`chips.ts`): `ports` (`:3000 :5173 +2`, cut to the
40-char chip limit, with a `url` to its first port) and `ssh` (`user@host`, like Warp's remote
login chip); chips are diffed like the sidebar items and cleared when their pane stops showing
them. Settings: `intervalSeconds` (1–60, the focused scan interval) and `portHost`
(`localhost` or `127.0.0.1` for the port links). Why a host setting: `localhost` may resolve to
`::1` first, and a dev server bound to `127.0.0.1` only then fails to load. `pine ports ls [--all]` returns the same data (`--all` needs `all-workspaces`).
The rail hides these items with `sidebar.showPorts` / `sidebar.showSSH`
(`lib/sidebarItems.ts`), under `sidebar.showExtensionItems`.

**Tool extensions: trellis and keeper.** Both are built-ins that only shell out to the user's
CLIs (`runTool` in the SDK: no shell, stdin closed, timeout, `missing` on ENOENT) and use nothing
but the public API.
- *trellis* (`src/extensions/trellis/`). Project of a workspace = the nearest `.trellis` marker
  (`/KEY` or `/KEY/boards/<slug>`) above its workDir, walked like trellis does (never `$HOME`,
  stop at a `.git`). Sidebar: per workspace, `card ls --json --all` + `column ls --json` for that
  project → open (not in an `is_done` column) and claimed (claim not expired) counts, refreshed
  every 60 s, on pane/cwd/focus events and on card events. Panel: `trellis ui --json` prints the
  running daemon's URL and exits; if nothing runs it serves in the foreground and prints nothing,
  so after 1.5 s the extension treats that child as its own server, reads the address from
  `daemon status --json`, and kills it on shutdown. The webview never sees the trellis token: it
  loads a loopback proxy in the extension (`proxy.ts`) that sets its own HttpOnly cookie from a
  one-time entry link, redirects to `/p/<KEY>[/b/<slug>]`, and forwards every request with
  `X-Trellis-Token`, the upstream `Host`/`Origin` and no browser cookies. Why a proxy: trellis
  trades its token for a cookie only at `/` and then redirects to `/`, so a deep link to the
  workspace's project can't be expressed as a URL. Events: a consumer named after the product
  (`pine`) runs `events --follow`; a brand-new consumer is first paged through and acked so
  history doesn't notify; acks are batched every 2 s; the follower restarts with backoff
  (2 s · 2ⁿ, 5 min cap). A card moved by an `agent:` actor into a column named like
  review/needs-you/waiting (or blocked) in a project some workspace has open posts a notification
  whose click opens the panel at `/p/<KEY>/card/<REF>` (`cardPath`), or navigates the open panel
  there; `ext.panel` with an allowed path (`isAppPath`: `/`, a project, a board or a card) returns
  the proxy's entry link for it. When the card's project isn't in the last known set, the
  extension lists the workspaces again before dropping the event. Why: the extension starts with
  the window, before the renderer has reported its workspaces, so its first refresh sees none and
  a review notice right after launch was lost. Settings: `notifyReview`, `notifyBlocked` and
  `refreshSeconds` (10–3600). "Trellis: Open Card" (`card <REF>`, palette `argument`) opens the
  panel at a card; the ref is upper-cased and must look like `KEY-123`. "Trellis: Init Project Here" runs `trellis init` in the caller's cwd
  (else workDir) after `ext.confirm`.
- *keeper* (`src/extensions/keeper/`). Only three argv are ever run (`isAllowedKeeperCall`):
  `daemon status` (never starts the daemon), then `approve --json` (list mode: no ticket, so it
  cannot decide anything; with a ticket keeper would also demand a TTY) and `ui` (prints the
  dashboard origin). Both of the latter auto-start the daemon, so they run only when `daemon
  status` says it's up. Polling: 5 s while approvals wait or a window has focus, 60 s otherwise,
  exponential backoff (to 5 min) while the daemon is down, none once keeper is missing (focus
  re-checks); the 5 s and 60 s are the `pollSeconds` and `idlePollSeconds` settings, and `notify`
  turns the notices off. The footer item appears only while something waits; a new ticket posts
  "Keeper needs approval" with the panel path `/approvals`. Why not the ticket's own page:
  Keeper's dashboard routes are `/approvals`, `/r/:requestId` (a local input/authorization
  request, not an approval ticket) and section pages; the approvals list keeps the open row in
  component state, so no URL addresses one ticket. The approval list keeps ticket, agent,
  workspace, intent, connection, tier and age, never the SQL; nothing about connections or DSNs
  passes through pine.
- Unavailable tools: no sidebar items, commands fail with a message that says what to install or
  start, and the panel shows a static explanation page (`startMessageServer`).
- They depend on phase 4's extension access to `workspace.list`, `caller.cwd` and `focus.changed`
  and degrade without them (no per-workspace items; cwd falls back to workDir; idle poll rate).

**System** (`src/extensions/system/`). Lets an agent learn about the machine and ask the human to
install packages instead of running `sudo` itself.
- `info`: OS from `/etc/os-release` (or `/usr/lib/os-release`; `sw_vers` on macOS, the kernel
  release on Windows; `os.ts`), kernel, arch, `$SHELL`, whether it runs as root, and which of
  pacman, paru, yay, apt, dnf, zypper, apk, brew, flatpak, snap, nix-env, winget are executable
  on `PATH` (`managers.ts` `findOnPath`, PATHEXT on Windows). The default manager comes from the
  distro id then `ID_LIKE` (Arch family → pacman, Debian family → apt, Fedora/RHEL → dnf, SUSE →
  zypper, Alpine → apk, NixOS → nix-env, macOS → brew, Windows → winget); if that one is missing,
  the first system manager found. AUR helpers, flatpak and snap are never the default.
- `install <pkg...> [--manager <name>] [--reason <text>]` (manifest `interactive: true`):
  `planInstall` (`install.ts`) validates every name against `^[A-Za-z0-9][A-Za-z0-9@._+:-]*$`
  (≤ 128 chars, ≤ 32 names; so no flags, paths or shell syntax), checks the manager is known and
  on `PATH`, and builds the argv (`sudo` prepended for root managers unless already root; never
  for brew, flatpak, nix-env or AUR helpers, which refuse or misbehave as root; winget one exact
  id at a time). The exact quoted line and the agent's reason go into `ext.confirm` (Approve /
  Deny, localized in `strings.ts`). Denied → `{ok: false, error: 'denied', data: {approved:
  false, command}}` and nothing runs. Approved → `ext.openTerminal` right of the caller's pane
  with the caller's cwd → `{approved: true, command, paneId}`. The package manager is never run by
  the extension itself: the human sees the sudo prompt and output live in the new pane, and the
  manager's own confirmation (no `-y`/`--noconfirm`) is a second check.
- E2E (`e2e/system.spec.ts`) answers the dialog by replacing `dialog.showMessageBox` in the main
  process through Playwright's `app.evaluate`, and records the options it was called with. There
  is no test seam in the app: the native dialog can't be clicked by Playwright, and the stub runs
  the real `confirmForExtension` code path up to the OS call.

**Built-ins.** `src/extensions/{git,trellis,keeper,system}` are built by `scripts/build-extensions.mjs`
(esbuild: `main.ts` → node CJS bundle, `panel.ts` → browser IIFE; `sdk/panel.css` → `base.css`)
into `out/extensions`; electron-builder ships that dir as `extraResources` and keeps it out of
the asar (a process can't use an asar path as cwd). They use only the public API through the
small SDK in `src/extensions/sdk/`; their panels are served by an HTTP server on 127.0.0.1 in
the extension process, gated by a per-run secret in the URL/header, a `Host` check, and an
`Origin` check, and pushed live changes over SSE.

### Declarative views

A view is UI an agent can build without an extension process: one JSON file in
`$XDG_CONFIG_HOME/pine/views/<name>.json`, drawn by the renderer with Pine's own components
(`docs/EXTENSIONS.md` has the format).

- **Schema** (`shared/views.ts`, `shared/viewBindings.ts`, `shared/viewSchema.ts`,
  `shared/jsonLocated.ts`). `parseViewText` parses with a small location-tracking JSON reader
  (duplicate keys refused, every value's line recorded by path) and validates strictly: known
  node types and properties only, enums, http/https URLs, bindings whose first name is a data
  source or an enclosing list's `as`, and the static budget (200 nodes, 10 levels). It reports
  every problem as `{path, line, message}` and records which data sources the view reads
  (`sources`) and whether it needs a clock tick (`ticks`). `viewJsonSchema()` is the published
  schema; a test keeps its node types equal to the validator's. Why a hand-written reader:
  agents iterate on `file:line: path: message`, and `JSON.parse` gives neither lines nor paths.
- **Bindings** are `{{path | filter}}`: a path is names and indices, nothing is evaluated.
  `lookup` follows only own properties of plain objects and array indices, and refuses
  `__proto__`/`constructor`/`prototype` again at runtime, so `{{x.constructor}}`,
  `{{list.length}}` or `{{s.toString}}` are undefined, never a function. A whole-string binding
  keeps its type (`resolveValue`), so `{"index": "{{ws.index}}"}` passes a number.
- **Main** (`viewHost.ts`, `viewsIpc.ts`). `ViewHost` reads `*.json` whose stem is a view name
  (at most 50), refuses symlinks, non-files and files over 64 KiB (`readViewFile`), and keeps the
  last doc that parsed per name (`lastGood`), so a broken edit to an enabled view reports its
  problems while the old tree stays (`stale`). `fs.watch` on the folder, 150 ms debounce,
  rescans and broadcasts `views:changed` only when the listing changed. Enablement is
  `userData/views.json` (`ViewStore`, `{name: {enabled}}`); a file with no record is `pending`,
  and the tree (`doc`) is sent to the renderer only for enabled views. IPC: `views:list`,
  `views:set-enabled`, `views:reveal` (main shows the file it knows; the renderer names a view,
  never a path). Control methods: `view.list` (`read-board`) and `view.open` (`drive-self`,
  enabled panel views only, runs the renderer command `views.open` for the caller's pane). Why no
  enable method on the socket: approval is the human's, as with extensions (CLAUDE.md §4).
- **Renderer.** `stores/viewsStore.ts` holds the listing; `lib/views.ts` registers
  `views.open` (hidden, `{name}`) and one palette command per enabled panel view
  (`views.open.<name>`, "Views: Open <title>"). `lib/useViewScope.ts` builds the data from the
  stores (`lib/viewData.ts` `buildViewScope`, only the sources the view reads; notifications
  load only when asked for; the clock ticks only when `ticks`). `lib/viewExpand.ts` turns the doc
  plus data into a render tree: lists expand with their item scope, `if` drops nodes, URLs that
  don't resolve to http/https become null, and the draw budget (50 items per list without
  `limit`, 1000 nodes) fails the whole expansion with a reason. `DeclarativeView.tsx` maps the
  tree to shadcn components and keeps the last good tree in a ref, showing the reason inline when
  over budget. Sidebar views render in `ViewsRail` below the workspaces (collapsible, hidden when
  the rail is collapsed); panel views are a `view` surface (`ViewSurface`, pane `viewName`,
  persisted in `workspaces.json`; an unknown or disabled view shows the way to Settings). Buttons
  go through `runCommandAction` (`lib/userActions.ts`), the same path as user actions, with the
  template args as the trust fingerprint and the view file named in the confirm dialog; links
  and `openUrl` go through `openSidebarUrl`. Why in core and not an extension: a data-only tree
  drawn with core components needs no process or webview, and drawing it with the real
  components is what makes it look native; the only inputs are data the stores already expose.

## 12. Sandboxed workspaces

Spec: `specs/sandbox/`. A human marks a workspace sandboxed; its pane shells and `pine process`
runs are then wrapped by `@anthropic-ai/sandbox-runtime` (srt: bubblewrap on Linux, Seatbelt on
macOS) and confined to the workspace folder and a firewalled network.

- **One sandbox host process per sandboxed workspace** (`main/sandbox/host.ts`, built with esbuild
  to `out/sandbox/host.mjs`, run with Pine's Electron as Node). Why: srt's `SandboxManager` is a
  per-process singleton with one proxy and one allowlist, so per-workspace domains, the ask
  callback and the package filter need a process each. If the host dies the workspace's network
  dies with it (fail closed). Why ESM: srt is ESM-only and Electron 33's Node can't `require` it.
- **`WorkspaceSandboxes`** (`main/sandbox/workspaceSandboxes.ts`) owns policy (`sandbox.json` in
  userData, keyed by workspace id, written only by owner-window IPC), builds the srt config
  (`srtConfig.ts`, pure) and wraps commands. `pty:attach` is async: a sandboxed shell spawns as
  `/bin/sh -c <wrapped>` with `TMPDIR` set to the workspace's private tmp. Why the pane gets its
  own state file as an extra write: the shell reports PATH and cwd through it, and a read-only
  file silently broke blocks and cwd tracking.
- **Reads**: home and Pine's data dirs are denied, the workspace folder, rc files and the human's
  `allowRead` lists are carved back in; carve-outs inside Pine's data dirs are dropped. Why: srt's
  `allowRead` beats `denyRead`, so listing the data dir would have exposed the vault. The shared
  sandbox tmp root is denied so one workspace can't read another's secrets.
- **Writes**: the workspace, its tmp and the agent CLIs' data folders, minus srt's mandatory list
  plus `.envrc`, `.git/hooks`, `.git/config` and `.pine/vault.json`. Why the explicit git paths:
  srt only protects hooks it finds when the shell starts, so a later `git init` left them
  writable. Cost: `git init` of a non-repo workspace fails inside the sandbox.
- **Network**: domains are global ∪ workspace ∪ until-restart. A host that isn't allowed is held by
  srt's ask callback while a `sandbox-domain` card waits (`domainRequests.ts`); one card per host,
  denied hosts refused until restart. Pine's browser in a sandboxed workspace follows the same
  allowlist (`browserFence.ts`) on `browse.open`, `will-navigate` and `will-redirect`.
- **Ports** (Linux): a sandboxed server lives in its own network namespace. `PortForwarder` listens
  on host `127.0.0.1:<port>` and bridges each connection with `nsenter --user --net` + `socat`
  into the namespace (no root, nothing running inside). Listeners are read from
  `/proc/<pid>/net/tcp` of a process inside; srt's own proxy bridges (socat on 1080/3128) are
  skipped. macOS needs no forwarding: loopback binding is allowed.
- **Secrets** (`main/secrets/`): Host secrets (ssh keys, token-like env vars, `gh auth token`) are
  read at use, never copied; Pine secrets are the vault. Saved browser logins are not secrets
  here: they stay with `browse.login` (SBX-D36). Grants inject real values as env
  or files; a granted SSH key is served by a per-workspace `ssh-agent`. Why not `GIT_SSH_COMMAND`:
  srt sets its own (with the proxy) and overrides Pine's.
- **Packages**: srt terminates TLS only for registry hosts (`excludeDomains` = every other allowed
  domain) and the host's `filterRequest` parses each download (`shared/packages.ts`) and checks
  deny/allow lists, OSV `MAL-*` records and the cooldown (`packagePolicy.ts`, lookups cached in
  `packageLookups.ts`). A deny returns 403 with the reason and is reported to main, which batches
  blocked packages into one card. The package managers' own cooldowns are set in the shell env.
- **Host panes**: a system install from a sandbox runs unsandboxed only through a one-time token:
  `ext.confirm({hostTerminal})` offers a grant bound to the exact argv after the human approves,
  `ext.openTerminal({host: true})` claims it, `pty:attach` consumes it (`hostPanes.ts`).
- **System requirements** (`main/systemRequirements.ts`): features register the programs they need;
  the sandbox needs bubblewrap, socat, ripgrep and util-linux (nsenter) on Linux. Turning the
  sandbox on is refused while any is missing, and the dialog offers the System extension's install.

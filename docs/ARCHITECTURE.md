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
- **extensions** (`src/extensions/`): built-in extensions (git, trellis, keeper) and their SDK. They run
  as separate processes and reach pine only through the control socket (§11).

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
| `settingsSync.ts`, `settingsSyncIpc.ts` | Settings sync: pure plan/merge + the file executor; triggers (startup, window focus, local file changes) and `sync:*` / `dialog:pick-folder` IPC (§5) |
| `browse.ts` | `browse.*` automation of browser panes (§9) |
| `browsePick.ts`, `guestNetwork.ts` | Pick element: `browse.pick`, `browser:pick-*` IPC, UI-issue reports; failed-request buffer per guest (§9) |
| `externalEditor.ts` | "Open in External Editor": resolves `behavior.externalEditor` (or auto-detects code/cursor/zed on `PATH`) and spawns it with an argv array (§9) |
| `gateway/` | LAN gateway: `index.ts` (methods + IPC), `server.ts`, `controlDispatch.ts`, `devices.ts`, `pairing.ts`, `cert.ts`, `interfaces.ts` (§7) |

Why the control-plane modules never import `main/index.ts`: that creates an import cycle.
`index.ts` passes its functions in instead (`registerControlServer(deps)`,
`registerPaneListMethods`, the gateway's deps).

### Data locations

- `~/.config/pine/settings.json` (Electron `userData`): settings, including `capabilities.grants`.
- `userData/gateway/{cert,key}.pem`: gateway TLS identity.
- `$XDG_DATA_HOME/pine/` (default `~/.local/share/pine/`): `workspaces.json`, `scrollback.json`,
  `notifications.json`, processes, bus, global vault, `gateway-devices.json`,
  `gateway-config.json`, `gateway-pair-audit.log`.
- `<workDir>/.pine/`: project-scoped vault. Older versions also kept a kanban `board.json` and a
  `wiki.json` here (and a global `$XDG_DATA_HOME/pine/wiki.json`); those extensions were removed in
  favour of Trellis, and pine leaves the files in place without reading them.
- `userData/extensions.json`: per-extension `{enabled, approved}` records (§11).
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
| fs | `list`, `read`, `write` (confined by `resolveSafe` to `[homedir, userData]`) |
| lsp | `list`, `start`, `send`, `stop`, `onMessage`, `onExit` |
| settings / workspace | `settings.path`; `workspace.save`, `workspace.load` |
| lifecycle | `lifecycle.emit` (`pane-created`, `pane-closed`, `workspace-added`, `workspace-closed`, `workspace-activated`, `workspace-state`) |
| commands | `publish` (renderer's command list), `onInvoke` (run a command for main) |
| terminal state | `terminalState.push` |
| browser | `register`, `unregister`, `pickStart`, `pickCancel`, `pickSend`, `onPickState` (push channel `browser:pick-state`) |
| extensions | `list`, `setEnabled`, `approve`, `invoke`, `panel`, `sidebarItems`, `onChanged`, `onSidebar`, `onOpenPanel`, `onOpenDiff` (push channels `extensions:changed`, `extensions:sidebar`, `extensions:open-panel`, `extensions:open-diff`) |
| external editor | `externalEditor.open({template, file, line?, column?})` (IPC `editor:open-external`, §9) |
| gateway | `enable`, `disable`, `pair`, `status`, `devices`, `revoke`, `bind-options`, `set-cap` (IPC only) |
| notifications | `list` (newest first), `post`, `clear`, `onChanged`, `onActivate` (push channels `notifications:changed`, `notifications:activate`) |

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
- **Other shells** spawn with no integration.
- **`pine()` shell function**: it runs `ELECTRON_RUN_AS_NODE=1 $PINE_NODE $PINE_CLI`, so no
  system Node is needed. electron-builder unpacks `out/cli/**` from the asar for this.

- **Claude hooks** (`shellIntegration.ts` `claudeHookSettings`): the generated init defines
  `claude() { command claude --settings <dir>/claude-settings.json "$@"; }`, whose hooks call
  `pine resume-token` and `pine state`. Why a flag and not the user's settings: we never write the
  user's dotfiles or `~/.claude`, and `--settings` is merged with theirs, so it adds hooks without
  replacing any. Codex has no equivalent (its `notify` is a single value, and overriding it would
  drop the user's), so Codex stays a manual recipe.

### Rendering, blocks, state

- `Terminal.tsx` registers OSC 7 (cwd, raw path) and OSC 133 A/B/C/D handlers. Scrollback is 10k.
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
  marks on replay), not closed panes.
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
- **Terminal palette** (`components/terminalTheme.ts`): xterm draws to canvas and can't read CSS
  variables, so each theme's palette is duplicated here. Only `adeberry` and `one-dark-vivid` have
  palettes; other themes fall back to One Dark Vivid.

## 5. Renderer model

### Workspaces, layout, surfaces

- **Workspace** (`stores/workspacesStore.ts`) → **split tree** (`layout/tree.ts`, pure; `stores/layoutStore.ts`)
  → **Pane** → one **Surface**: `terminal | editor | browser | extension | diff`.
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
- **Workspace rows** (`components/DeckRail.tsx` `WorkspaceRow`, `lib/workspaceOrder.ts`): cmux-style
  rows. Title is the user's name or the folder; under it the latest message that still needs
  you (or the running program's title), then an optional description, then path and extension
  items. `pine workspace describe` (→ `workspace.describe`, drive-self, caller's workspace) or the
  row menu sets the description; it renders Markdown restricted to links, emphasis and code, as a
  sibling of the row button so links are real links (a link inside a button is invalid and would
  select the row). The row menu renames, edits the description, pins, moves, marks read and
  closes others; rows drag to reorder. Pinned workspaces stay contiguous at the top: every move
  goes through `moveTo`, which clamps to the pinned or unpinned group. `Ctrl/⌘+1..9` runs
  `workspace.goto` with the digit's index (`lib/useModifierHint.ts` shows the digits).
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
- **Surface persistence** (`components/SurfacePool.tsx`, `stores/surfaceSlotsStore.ts`):
  - SurfacePool portals every pane's surface, across all workspaces, into a persistent,
    absolutely-positioned host div created in a detached parking holder.
  - `Pane` has a callback ref that calls `mountSurface`, which moves the host into the pane's slot.
    `parkSurface` moves it back, but only if that slot still owns it.
  - `releaseSurfaces` drops hosts for pane ids that no longer exist.
  - Why: the portal target never changes, so split, move and zoom only move DOM nodes. xterm,
    Monaco and webview state survive, and ptys are not re-attached.
- **Split rendering** (`PaneTree.tsx`): Allotment keyed by the child-id list. Why: Allotment
  caches sizes, so a structural change must rebuild it or panes collapse to a sliver; a pure
  resize keeps the instance.
- **No workspaces** (`workspacesStore.ts`, `WorkZone.tsx`): zero workspaces is a valid state. The store
  starts empty (`activeWorkspaceId: null`); only the user (`workspace.new`, the sidebar or empty-state
  button, Ctrl+Shift+T / ⌘T, opening a file with no workspace via `lib/openFile.ts`) or restore
  creates one, and closing the last workspace leaves none. The work zone then shows the empty
  state. With no active workspace, pane commands are no-ops, `pane.list`/`workspace.list` return
  `[]`, extension panels and diffs are not opened, and `workspace-activated` is not emitted. Why:
  a terminal the user didn't ask for is noise, and re-seeding one on close made the last
  workspace impossible to get rid of.
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
is the number of unread panes; the popover lists main's notification log newest first (workspace ·
pane, message, time), reloads on `notifications:changed`, and each entry reveals its pane
(entries whose pane is gone are disabled). "Clear all" empties the log and marks every pane read.
The log (`main/notify.ts`, `notifications.json`, capped at 500) holds `pine notify` calls and the
renderer's posts (terminal escapes, long commands). Clicking a desktop notification restores and
focuses the window and sends `notifications:activate` with the pane id, which reveals it.
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
  Cmd+↑/↓ (previous/next block) and native Cmd+C/V/F. Other platforms use Ctrl+Shift+P,
  Ctrl+Shift+B, Ctrl+, Ctrl+Shift+U, Ctrl+Shift+H, Ctrl+Shift+T, Ctrl+Shift+↑/↓ and
  Ctrl+Shift+C/V/F (copy/paste/find). Plain Ctrl+T stays with the shell (readline transpose). On Linux some IBus
  setups claim Ctrl+Shift+U for Unicode entry before the app sees it; the palette's "Jump to
  Latest Unread" and the bell still work there.
  - Any combination with Alt is ignored.
  - App.tsx has a window keydown listener that runs app chords.
  - Inside the terminal, xterm's key handler returns false for app chords so they reach the
    window listener.
  - On non-mac platforms the terminal handles copy, paste and find itself. Block navigation is
    terminal-local on every platform.

### Settings and plugins

- `stores/settingsStore.ts` persists `userData/settings.json` (debounced 300 ms): `locale`,
  `appearance` (theme + ui/terminal/editor fonts), `behavior` (`showHiddenFiles`, `cursorStyle`,
  `cursorBlink`, `restoreWorkspace`), `capabilities.grants`, `sync.dir`.
  - `setByPath` rejects prototype-pollution segments, keys outside locale/appearance/behavior,
    and type changes.
  - `capabilities.grants` is changed only by hand-editing the file, and is read at startup.
  - `settings/schema.ts` registers a JSON Schema for that file with Monaco.
- `plugins/builtin.ts` is a registry of built-in contributions only: themes (`adeberry`,
  `one-dark-vivid`, `instrument-night`, `dracula`, `oxocarbon`), LSP entries, locales (`en`, `zh-Hant`).
  These are data-only contributions; behavior and UI come from extensions (§11), listed in the
  same Settings → Plugins section.
- i18n: typed catalogs in `i18n/dict.ts`, read via `useDict()`.

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
- Elevated caps are granted only by `capabilities.grants` in `settings.json`. A grant applies to
  every pane, is read once per run, and unknown names are dropped.
- `phone`, `shell` and `destructive` are never checked on the socket.

**Methods.**
- `controlServer.ts` itself serves `hello`, `whoami`, `command.list`, `command.exec`, `pane.info`,
  `cwd.get`.
- Other modules add methods with `registerControlMethod(name, {cap, callers, handler})`;
  `callers` defaults to `panes` (see §11 for extension identities).
- `command.exec` goes through main's `execCommand`: `command:invoke` IPC to a window's registry,
  answered by `command:result`, 5 s timeout. A target with no window goes to the first window.
- If the target differs from the caller's own pane, window or workspace in any way, the caller
  needs `all-workspaces`. Each command's declared capabilities are checked as well.

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

Two files written by two processes (see CLAUDE.md §6): the renderer writes `workspaces.json`
(layout), and main writes `scrollback.json` (each pane's serialized screen).

- **Layout** (`stores/persistence.ts`, `layout/snapshot.ts`): saved 400 ms after any change to the
  workspaces, layout or settings stores, plus once at start and once on `beforeunload`.
  - With no workspaces, `buildSnapshot` writes an empty workspace (`workspaces: []`,
    `activeWorkspaceId: null`) and `parseSnapshot` accepts it, so a restart after closing every
    workspace restores zero workspaces instead of the last non-empty snapshot.
  - `zoomedPaneId` is not saved.
  - Diff panes are not saved (`withoutKind(root, 'diff')`); a workspace whose only pane is a diff
    comes back as a terminal at its workDir, and focus moves to a surviving pane. Why: their
    content is in memory only (nothing live is restored).
  - The two node converters are a compile-time check that `layout/types.ts` and the snapshot
    types in `shared/types.ts` agree.
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

- **Monaco** (`monaco/setup.ts`, `components/Editor.tsx`):
  - Workers are bundled with Vite `?worker` imports (editor, json, css, html, ts), with no CDN.
  - The editor uses the single `one-dark-vivid` Monaco theme; it does not yet follow the app theme.
  - Ctrl/Cmd+S saves through `fs.write`. Dirty state compares `getAlternativeVersionId` with the
    saved version (mirrored to `editorStatusStore`).
  - Files with a NUL byte in the first 8 KB are not opened.
- **Diff view** (`components/DiffView.tsx`): Monaco's `createDiffEditor`, read-only
  (`originalEditable: false`), side-by-side with an inline toggle, same theme and editor font as
  the editor. Models are plain in-memory models (no file URI), so they never collide with an open
  editor's model; they are disposed when the content changes or the pane unmounts. Core knows
  nothing about git: any extension can open one via `ext.openDiff` (§11).
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
    edits it (Settings → Files, or `settings.json`).
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
- **Automation** (`main/browse.ts`): about 45 `browse.*` methods, all behind the elevated
  `browse` cap.
  - **Target**: an explicit pane id is an external id, and driving another workspace's pane also
    needs `all-workspaces`. With no pane id, the first browser pane in the caller's workspace is used.
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
  - **Limits**: console and errors 500 each, dialogs 200, snapshot 2000 nodes, depth 40
    (max 200).

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
anything with commands/sidebar items/url panel needs `main`). A broken manifest is logged and
skipped without affecting the others. A user extension reusing a built-in id is rejected.
Discovery runs once at startup.

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
`PINE_SOCKET`, `PINE_TOKEN`, `PINE_EXTENSION_ID`, `PINE_EXTENSION_DIR` and none of the pane
variables. `controlServer` checks the caller kind per method (`callers: 'panes' | 'extensions' |
'all'`): extension identities can call `hello`, `whoami` and the extension-only `ext.*` methods;
panes can call everything else including `ext.list` / `ext.invoke`. Why: pane methods resolve
"self" from a pane id, and an extension has none; letting it through would make `command.exec`
target whichever window happened to be first.

**Processes** (`extensionHost.ts`).
- `main` ending in `.js/.cjs/.mjs` runs with the app's Electron binary and
  `ELECTRON_RUN_AS_NODE=1` (like the `pine` CLI), anything else is executed directly; cwd is the
  extension dir.
- Lazy start: the first invoke, panel resolution, or (for extensions with `sidebarItems`) window
  creation. A command waits until the process has registered it (`ext.registerCommands`), 10 s max.
- On exit the identity is revoked, the server-side connection is disposed (which rejects any
  in-flight request immediately rather than at the 30 s timeout), subscriptions and sidebar items
  are dropped, and the process is restarted after 500 ms · 2ⁿ, at most 3 times; then the status
  is `crashed` until the user disables and re-enables it.
- `before-quit` sends SIGTERM to every extension process.

**Methods.** Extension → pine: `ext.registerCommands`, `ext.subscribe`, `ext.setSidebarItem`,
`ext.notify` (needs `notify`), `ext.openPanel`, `ext.openDiff`, `ext.confirm`, plus the shared
read methods `workspace.list` / `pane.list` (`callers: 'all'`, need `read-board`). Pine → extension:
`ext.command` and `ext.panel` requests, `ext.event` notifications. Pane → pine: `ext.list`,
`ext.invoke`.
- `ext.openDiff` validates (title, both sides strings ≤ 5 MiB, absolute `path`) and main sends
  `extensions:open-diff` to the workspace's window, where `openExtensionDiff` opens the diff pane
  (§5, §9). Why a generic diff and not a git view: the first consumer is git, but a diff of two
  texts is what any VCS, formatter or code-review extension needs, and core stays VCS-agnostic.
- `workspace.list` includes `activePaneId` (external id) so an extension can follow "the pane the
  user is in" without a pane-scoped method.
- The caller context carries `cwd`: for a pane caller the pane's live terminal cwd
  (`cwdForPane`, from `terminal:state`), for a palette call the active pane's.
- `ext.confirm {title, message, detail?, confirmLabel?, cancelLabel?}` shows a native question
  box on the focused window (`extensionConfirm.ts`), always naming the extension, Cancel as the
  default; it resolves `{confirmed}`. Why a dialog in main rather than in the panel: the action
  may come from the palette or an agent's `pine` call with no panel open, and a confirm the
  extension draws itself proves nothing about the human.
- `ext.notify {…, openPanel: true}` (extensions with a panel) records the notification with the
  extension's id (`NotificationEntry.extId`); clicking it, on the desktop or in the notification
  center, opens that extension's panel instead of jumping to a pane.
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
  characters, and rendered in the workspace row or the sidebar footer (no workspace).

**Panels.** `ExtensionPanelView` asks main for the source (`extensions:panel`):
- file entry: `file://` URL of the html inside the extension dir;
- `url` entry: main asks the process (`ext.panel` with a user caller carrying workspace, workDir,
  locale) and accepts only an `http://127.0.0.1|localhost` URL, remembering its origin.
The webview uses partition `pine-ext-<id>`, and `will-attach-webview` refuses it unless the src
passes `isAllowedPanelUrl`. The guest gets the same hardening as browser panes (no preload, no
node, sandbox, context isolation) plus: permission requests denied, `window.open` routed to
`openExternalSafe`, and navigations/redirects outside the allowed file dir / origin blocked. The
renderer injects the theme into the guest as `--pine-*` custom properties (`lib/panelTheme.ts`).
Why panels talk only to their own process: the guest has no `window.pine` and no token, so a
compromised or buggy panel can do no more than its extension already can.

**Git** (`src/extensions/git/`, the first built-in written for the API rather than migrated):
- Sidebar: per workspace, the repo of the workspace's active pane cwd (else the last active
  terminal's, else the first terminal's, else the workDir; `workspaces.ts`) gets one item:
  branch (or short sha when detached), `↑ahead ↓behind` when there is an upstream, `+new`
  (untracked or staged adds) and `~changed` (everything else), counted per path from
  `git status --porcelain=v2 --branch -z --untracked-files=all` (`status.ts`). Non-repo → no
  item. Refreshed 300 ms after `cwd.changed`, `command.finished`, `pane.created/closed`, and
  every 10 s only while a pine window is focused (`focus.changed`); a refresh in flight coalesces
  the next. Why the poll: edits by an editor or agent outside a terminal command fire no event.
- Git runs with `GIT_OPTIONAL_LOCKS=0` so background status never takes the index lock from
  the user's own git commands.
- Diff sides: staged = `HEAD` vs index, unstaged = index vs working file, untracked = empty vs
  working file, conflicted = `HEAD` vs working file (with markers); blobs via `git cat-file blob`.
  Binary (NUL in the first 8000 bytes) and > 2 MiB sides are refused; a symlink shows its target
  path, never the file it points to.
- Commands: palette "Show Changes" opens the panel (served from its process by `startPanelServer`); the
  panel lists conflicts/staged/changes/untracked and a click calls `open`, which calls
  `ext.openDiff`. CLI/agents: `status`, `changes`, `diff <path> [--staged]` (unified patch),
  `open <path> [--staged]`, all JSON. A path argument must match a changed file (resolved from
  the caller's cwd, or repo-relative), so it can't be used to read arbitrary files.


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
  that opens the panel. "Trellis: Init Project Here" runs `trellis init` in the caller's cwd
  (else workDir) after `ext.confirm`.
- *keeper* (`src/extensions/keeper/`). Only three argv are ever run (`isAllowedKeeperCall`):
  `daemon status` (never starts the daemon), then `approve --json` (list mode: no ticket, so it
  cannot decide anything; with a ticket keeper would also demand a TTY) and `ui` (prints the
  dashboard origin). Both of the latter auto-start the daemon, so they run only when `daemon
  status` says it's up. Polling: 5 s while approvals wait or a window has focus, 60 s otherwise,
  exponential backoff (to 5 min) while the daemon is down, none once keeper is missing (focus
  re-checks). The footer item appears only while something waits; a new ticket posts "Keeper
  needs approval", which opens the panel on `/approvals`. The approval list keeps ticket, agent,
  workspace, intent, connection, tier and age, never the SQL; nothing about connections or DSNs
  passes through pine.
- Unavailable tools: no sidebar items, commands fail with a message that says what to install or
  start, and the panel shows a static explanation page (`startMessageServer`).
- They depend on phase 4's extension access to `workspace.list`, `caller.cwd` and `focus.changed`
  and degrade without them (no per-workspace items; cwd falls back to workDir; idle poll rate).

**Built-ins.** `src/extensions/{git,trellis,keeper}` are built by `scripts/build-extensions.mjs`
(esbuild: `main.ts` → node CJS bundle, `panel.ts` → browser IIFE; `sdk/panel.css` → `base.css`)
into `out/extensions`; electron-builder ships that dir as `extraResources` and keeps it out of
the asar (a process can't use an asar path as cwd). They use only the public API through the
small SDK in `src/extensions/sdk/`; their panels are served by an HTTP server on 127.0.0.1 in
the extension process, gated by a per-run secret in the URL/header, a `Host` check, and an
`Origin` check, and pushed live changes over SSE.

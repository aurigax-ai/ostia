# CLAUDE.md — pine (Terminal Workspace)

Rules for any agent (or human) changing this repo. Read this before touching code. When you
change an invariant, command, or convention, update the matching section here in the same commit.

| Doc | Holds |
|---|---|
| `PRODUCT.md` | Who it's for, principles, and the **Goals** table (built / partial / not started) |
| `docs/ARCHITECTURE.md` | How it's built, module map, and every "Why:" behind non-obvious code |
| `docs/DESIGN.md` | Tokens, type scale, components, a11y rules |
| `docs/ROADMAP.md` | Lean-core architecture (core / built-in extensions / plugins) and phased plan |
| `docs/CHROME.md` | Pairing agents with the user's real Chrome (Chrome DevTools MCP) vs Pine's browser |
| this file | Rules you must follow while editing |

---

## 0. No code comments

**The code has no comments. Do not add any.** Not `//`, not `/* */`, not JSDoc, not `{/* */}` in
JSX, not in CSS, not in tests. Comments go stale and agents trust them over the code; that has
caused real bugs here.

- Names carry the *what*. Extract a well-named function or constant instead of writing a comment.
- The *why* goes in `docs/ARCHITECTURE.md` (a "Why:" note in the relevant section) or, if an
  agent editing that code must know it, in §4 / §6 of this file.
- Allowed: tool directives only (`biome-ignore`, `@ts-expect-error`, `/// <reference>`).
- Enforced: `pnpm lint` runs `node scripts/comments.mjs --check` and fails on any comment.
  `node scripts/comments.mjs` (no flag) strips them.
- Generated shadcn files in `src/renderer/components/ui/**` are exempt; hand-edit them only to
  swap animation classes (§5 Motion), their icons to Phosphor (§5 UI), or to wrap a component
  in `forwardRef` (React 18 drops `ref` on plain function components; `Input`, `InputGroupInput`).
- Strings are not comments: `#` lines inside the generated shell rc templates stay.

---

## 1. What this is

`pine` is a cross-platform (Linux-first) terminal-first workspace: a Warp-like terminal with command
blocks, split panes, a file tree + Monaco editor with LSP, an in-app browser agents can drive, and a
control plane (the `pine` CLI over a local socket, plus an optional LAN gateway for a phone
companion). Electron + React + TypeScript.

> **`pine` is a codename.** Runtime strings use `PRODUCT_NAME` from `src/shared/product.ts`;
> packaging uses `package.json` `name`. Never hardcode the product name in a new subsystem.
> (Identifiers such as `window.pine`, `PINE_*` env vars and `__pine_*` shell symbols are code,
> renamed with a search-and-replace.)

---

## 2. Commands

Package manager is **pnpm** only.

| Command | What it does | Run it when |
|---|---|---|
| `pnpm dev` | electron-vite dev (HMR renderer, main/preload reload) | Daily development |
| `pnpm build` | Build `out/{main,preload,renderer}`, the `pine` CLI, the built-in extensions (`out/extensions`), and the build stamp `out/build-info.json` (version, commit, time; packaged as `resources/build-info.json`) | Before `preview` / E2E |
| `pnpm build:extensions` | Only the built-in extensions (`scripts/build-extensions.mjs`) | After editing `src/extensions/**` while `pnpm dev` runs |
| `pnpm preview` | Run the built app | Smoke-test a build |
| `pnpm package` | `build` + electron-builder → `dist/linux-unpacked/` | Producing an installable build |
| `pnpm icons` | Render the app icon PNG set from `resources/icon.svg` (`rsvg-convert`) | After changing the icon SVG |
| `pnpm install:local` | `package` + `scripts/install-linux.sh` → `~/.local/share/pine/app` + desktop launcher | Updating the user's installed app |
| `pnpm bump <patch\|minor\|major>` | Raise `package.json` `version` (semver) | Before every `pnpm install:local` that ships changes: `patch` for fixes, `minor` for features. Commit it as `chore(release): vX.Y.Z` and tag `vX.Y.Z` |
| `pnpm typecheck` | `tsc --noEmit` for renderer/shared, then main/preload/shared | **Before every commit** |
| `pnpm lint` | Biome check + the no-comments check | **Before every commit** |
| `pnpm format` | Biome format (`src`) | Before commit |
| `pnpm rebuild` | `electron-rebuild -f -w node-pty` | After any Electron bump, fresh install, or ABI change. Without it terminals show "node-pty unavailable" |
| `pnpm test` | Vitest `node` + `dom` projects | Before commit; while developing |
| `pnpm test:unit` | Only the `node` project | Fast main-process loop |
| `pnpm test:e2e` | Playwright against the **built** app, on a virtual display (`xvfb-run`) so windows never appear or steal focus. `PINE_E2E_VISIBLE=1` shows them | After `pnpm build` and `pnpm rebuild`. Never call `playwright test` directly |

---

## 3. Architecture in one screen

- **main** (`src/main/*.ts`, `src/main/gateway/`): windows, ptys, fs (read + write, confined),
  LSP processes, background processes, JSON stores, control socket, gateway.
- **preload** (`src/preload/index.ts`): the single `contextBridge` surface. Forwards only.
- **renderer** (`src/renderer/`): React 18, zustand stores, xterm.js, Monaco, cmdk. No Node access.
- **shared** (`src/shared/`): dependency-free types, the `PineBridge` IPC contract, capabilities.
- **cli** (`src/cli/index.ts`): the `pine` CLI. Panes get a `pine()` shell function that runs it
  with the app's own Electron binary (`ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI"`), so no
  system Node is needed.
- **extensions** (`src/extensions/`): built-in extensions (git, trellis, keeper, system, ports) +
  their SDK. Each runs as its own process and talks to pine only over the control socket
  (`docs/EXTENSIONS.md`). The host that runs them is `src/main/extensionHost.ts`. trellis and
  keeper wrap the user's own CLIs; their fake stand-ins for tests are `test/fixtures/tools/bin/`.
- **settings sync** (`src/main/settingsSync.ts` + `settingsSyncIpc.ts`): mirrors settings and
  extension choices through the folder in `sync.dir`.

Security baseline for every window (`baseWebPreferences()` in `src/main/index.ts`):
`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. External links go through
`openExternalSafe` (http/https/mailto only).

Details: `docs/ARCHITECTURE.md`.

---

## 4. Invariants you must not break

- **Renderer has zero Node access.** New capability = type in `PineBridge` (`shared/types.ts`) →
  handler in `src/main/` → one-line forwarder in `src/preload/index.ts`.
- **main control modules never import `main/index.ts`.** Dependencies flow in via `register*`
  deps objects.
- **The pty lives in main, keyed by pane id**, and outlives renderer remounts. `pty:attach`
  re-binds and replays a capped buffer; `pty:detach` keeps it alive for `DETACH_GRACE_MS`, then
  reaps. pty lifecycle closures must check `ptys.get(paneId) === entry` before touching the map.
- **Tabs are a leaf slot, never a split.** A `tabs` node holds only panes and shows `activeId`;
  splits and edge drops act on the whole stack, a center drop adds a tab, one tab left collapses
  back to a pane. Whatever sets `activePaneId` also shows that tab (`patch` in `layoutStore`
  runs `selectTab`), and a background tab is not visible (`isPaneVisible`), so its signals ring.
  Hidden tab bodies stay mounted (`visibility: hidden` + `inert`), never unmounted: a webview
  moved or detached reloads.
- **A resume token is data, never a command.** `pine resume-token` stores `{agent, id}` on the
  pane only after `parseAgentResume` checks the agent is known and the id is `[A-Za-z0-9._-]`;
  the command is built by `resumeCommand` and typed only at an idle prompt when the human asks
  (Resume button, `agent.resume`), or, if the human turned on `agents.autoResume` (Settings;
  `settings.set` refuses it), for a pane whose agent was running at the last save
  (`agentRunning` in the snapshot → `resumePending`), once that pane is visible
  (`lib/autoResume.ts`). A command run in the pane first cancels it. Never store or replay a
  free-form command.
- **Hibernation only stops what it can bring back** (`lib/hibernationScheduler.ts`, off by
  default). It kills a pane's pty only if the pane has a resume token, its running block is
  that agent (`runningAgentOf`), it is not visible and idle past `idleSeconds`; never a shell at
  a prompt, a non-agent command, or a pane without a token. Main stashes the serialized screen
  first (`pty:hibernate`). Waking is always the human's act (the hibernated view's Resume, the
  header button, `agent.resume`): it spawns a fresh shell and types `resumeCommand` only at its
  first idle prompt (`runWhenIdle`). Revealing a hibernated pane never wakes it by itself, and
  `hibernated` is never persisted.
- **Surfaces never remount on split/move/zoom.** `SurfacePool` owns one persistent host element
  per pane and always portals into it; a pane's slot `appendChild`s that host. Don't portal into
  the slot directly. (Browser `<webview>`s still reload when moved; that's Electron.)
- **Shell-integration marks are the block/cwd source of truth.** Main injects OSC 133 (A/B/C/D) +
  OSC 7 for zsh/bash (`shellIntegration.ts`); other shells spawn without integration and still
  work. cwd flows out (terminal → pane → Files), never in.
- **Block positions are xterm markers, not line numbers.** Absolute line numbers drift on reflow
  and scrollback trim. Store `IMarker`-backed anchors; dispose them on reset/unmount. A block's
  command text is read once at OSC 133;C (B→C in the buffer) and stored; its output is read on
  demand from `buffer.normal` between the C and D markers (`lib/blockText.ts`), never cached.
- **The block overlay never covers text cells.** Gutter buttons sit in the host's left padding
  and the overlay is `pointer-events: none`; only the gutter and the sticky header take the
  pointer.
- **Nothing types into a pane unless it's at an idle prompt** (open draft, nothing running).
  Rerun and history insert go through `insertCommand` (`lib/blockActions.ts`), need the `shell`
  capability, and paste via `term.paste`. The one widening: a report reference from pick
  element or send selection (`lib/sendPick.ts` `canInsertReference`) may also be pasted into a
  running agent: one whose running command is `claude`/`codex` (`runningAgentOf`; their input box
  queues typed text), or any command that reported `waiting`/`done`; it's text only, never
  followed by Enter. A file dragged onto a terminal (from the tree or the OS) is the human's
  own paste: its shell-quoted paths go through the normal paste path (`lib/dropPaths.ts`),
  never with Enter. A file
  path from the file menu (`insertPathReference`, `@<path> `) follows the same rule. Anything
  else goes to the clipboard.
  The input editor (`behavior.inputMode: 'editor'`, `InputEditor.tsx`) submits through
  `insertCommand` too, and is shown only at an idle prompt on the normal buffer; anything
  running (or a TUI on the alternate screen) gets the keys straight through xterm. While it's
  shown, `insertCommand` without Enter fills the editor instead of the shell line, and keys,
  pastes and clicks aimed at xterm go to the editor (`inputEditorFor`), so the shell line stays
  empty under it. It sits in place over the shell's input line (placed from xterm's cursor,
  `lib/promptOverlay.ts`), never takes layout space and never resizes the pty; it covers only
  cells from the cursor on (the whole row for a same-line Pine prompt, plus the row above for
  the chip row), never output. Keys it doesn't own (Ctrl+R, Ctrl+T, Alt+letter, Escape) hand
  the draft to the shell line with a bracketed paste and then send the key (`handOffInput`), so
  zle/readline widgets like fzf keep working; the editor steps aside until the next prompt.
  To make room for a multi-line draft on the bottom row it scrolls xterm locally
  (`scrollUpSequence`), keeping the cursor on the prompt. Its command
  list (`pty:commands`) answers only the pane's own window and returns names only: executables
  listed from the pane's PATH directories plus what the shell wrote to its main-chosen
  `PINE_SHELL_STATE` file. The renderer never names a directory or file for it.
  Completion specs (`completions:spec`, `main/completionSpecs.ts`) are data only: the renderer
  sends a command name (`SPEC_COMMAND_PATTERN`), main reads `<name>.json` from the user's
  completions folder, then enabled extensions' `contributes.completions` folders, refusing
  symlinks and files over `SPEC_FILE_MAX_BYTES`, and validates it (`parseCompletionSpec`). Fig
  specs are converted to that JSON at build time; never ship or run their generator functions.
  The Pine prompt (`terminal.prompt.style: 'pine'`) only changes what the editor draws and the
  prompt of shells spawned while it's on: main passes `PINE_PROMPT` in the spawn env and the
  generated init sets a plain `cwd` + newline + `sep` prompt (one line `cwd sep` when
  `sameLine`, `PINE_PROMPT_LINES`) after the user's rc; never touch dotfiles, and
  never rewrite the prompt of a shell that's already running. `pty:prompt-context` answers
  only the pane's own window and runs node only as `execFile(..., { shell: false })`, never
  from the shell's prompt hook. Chips without a value are hidden (the editor's preview shows
  them as unavailable), never filled with placeholders.
- **Saved workflows are data, typed only by the human's pick.** Main alone reads and writes
  workflow YAML (`main/workflows.ts`): the renderer and agents name a workspace id, never a path;
  symlinks, files over 64 KiB and YAML aliases are refused, and every workflow (file or extension
  `contributes.workflows`) passes `parseWorkflow`. Saving writes a new file with `wx` into the
  user's workflows folder and never overwrites. A chosen workflow reaches the pane only through
  `insertCommand` without Enter (else the clipboard). Never add a command, socket method or CLI
  verb that inserts, runs or saves a workflow: `pine workflow` is `list` and `show` only.
- **Selection reports are checked in main.** A file view's capture travels whole over
  `selection:send`, so main re-validates it (`normalizeSelection`: kind, absolute path, clipped
  text, PNG signature, 25 MiB image cap, sender owns the source pane) and writes
  `selection-N.md`/`.png` only into `privateTmpDir('pine-reports')`, never next to the user's file.
  File viewers read bytes only through `fs.readBinary` (confined, 50 MiB cap).
- **Pick element runs in an isolated world** (`PICK_WORLD_ID`, `executeJavaScriptInIsolatedWorld`),
  never the page's main world, and counts only `isTrusted` events. `pickRuntime` must stay a
  self-contained function (it's shipped with `toString()`): no imports or module-level references
  inside it. Captures are truncated in main (`normalizeCapture`); the renderer sends back only a
  capture id, and reports go to `privateTmpDir('pine-reports')`.
- **Agent browsing keeps its state out of the page.** `pine browse` element work runs in
  `browseRuntime` (`shared/browseRuntime.ts`) inside `executeJavaScriptInIsolatedWorld(BROWSE_WORLD_ID, …)`,
  never the page's main world; like `pickRuntime` it is self-contained and shipped with
  `toString()`. Only `eval`, `wait --fn`, `pushstate`, the dialog override and `react-grab` run in
  the main world. Agent strings reach generated JS only as `JSON.stringify`-ed arguments, and
  every output or upload path goes through `resolveSafe`. The verbs follow agent-browser's
  contract (`cli/browseArgs.ts`); rename a verb there, in `docs.ts` and in the skill together.
- **The storage viewer only touches the human's own pane.** `browser:storage-*` IPC resolves the
  pane with `ownedGuest` (the sending window owns it) and validates every edit or removal in main
  (`normalizeStorageEdit` / `normalizeStorageRemoval`) before touching cookies or web storage;
  clear-all is confirmed in the panel first.
- **Never inject into the user's dotfiles.** zsh via a generated `ZDOTDIR` (+ `PINE_ZDOTDIR_ORIG`);
  bash via `--rcfile`. Generated files live in `privateTmpDir('pine-shell-integration')`:
  `<tmp>/pine-shell-integration-<uid>`, mode 0700, refused if it's a symlink or not ours.
- **Layout tree transforms are pure** (`src/renderer/layout/tree.ts`): no React, no store access.
  Transforms return the same object when nothing changed. `resetIds`/`adoptIds` are the only
  exceptions.
- **Ids minted from counters are adopted on restore** (`adoptIds`, `adoptWorkspaceIds`,
  `adoptGroupIds`). Skip it and a new pane reuses a restored pane's id, and two panes share one
  shell (or a new group silently merges with a restored one).
- **Workspace groups live on the flat workspace list.** `workspaces` is the one order; a group is
  a `groupId` on its members, kept contiguous by `normalizeGroups` (`lib/workspaceGroups.ts`),
  and a group with no members is dropped. Never add a second member list or order. Pinned and
  grouped are exclusive. Deleting a group never closes a workspace.
- **Nothing live is ever restored.** A restored workspace comes back idle with a fresh shell at its
  saved cwd; replayed scrollback is history. Same for `processManager` (running → exited at load;
  loaded entries can't be restarted).
- **Zero workspaces is a valid state.** Workspaces are created only by the user (New workspace button,
  `workspace.new`, the chord, opening a file with none open) or by restore; never seed one at boot,
  on an empty restore, or when the last workspace closes. `activeWorkspaceId` is `null` then, and
  every reader (commands, WorkZone, attention sync, extension bridge, autosave) must handle it;
  the work zone shows the empty state. An empty app is saved (`workspaces: []`) so a restart
  restores zero workspaces.
- **A workspace may have no panes.** A new workspace starts with no layout and shows New terminal
  / New browser; nothing (WorkZone, activation, restore) calls `ensure` on the user's behalf.
  Closing the last pane removes the layout and emits `pane-closed`. Opening a file, browser,
  panel or diff in an empty workspace makes it the first pane (`seedLayout`, only for a workspace
  that exists). Empty workspaces are saved without `root` and restored empty.
- **Closing and quitting ask only about running commands.** `lib/closeConfirm.ts` confirms closing
  a workspace, or any pane or tab that has a running command, and `main/closeGuard.ts` confirms quit and window close through
  the renderer; `before-quit` calls `preventDefault()` until approved, so the scrollback save
  and pty kill run once, after approval. New workspace paths call `startNewWorkspace()` (placement
  and folder settings), never `addWorkspace` directly. E2E seeds `workspaces.confirmQuit: false`.
- **Workspace/pane guards:** `closePane` emits `pane-closed` only if the pane existed; a
  workspace's `workDir` is the anchor, a pane's `cwd` wanders.
- **App chords must not steal terminal keys.** Linux/Windows: `Ctrl+Shift+P` palette,
  `Ctrl+Shift+B` sidebar, `Ctrl+,` settings, `Ctrl+Shift+U` jump to latest unread,
  `Ctrl+Shift+H` command history, `Ctrl+Shift+S` search saved workflows, `Ctrl+Shift+T` new
  workspace, `Ctrl+1..9` jump to a workspace,
  `Ctrl+=` / `Ctrl+Shift+-` / `Ctrl+0` zoom in / out / reset (zoom out is not `Ctrl+-`: readline
  binds that to undo, and the keybinding guard refuses it),
  `Ctrl+Shift+R` resume the pane's agent, `Ctrl+Shift+E` send a file view's selection to an
  agent, `Ctrl+Shift+C/V` copy/paste, `Ctrl+Shift+F` find, `Ctrl+Shift+↑/↓` previous/next block.
  macOS uses ⌘ (⌘= ⌘- ⌘0 zoom, ⌘⇧U unread, ⌘⇧H history, ⌘⇧S workflows, ⌘T new workspace, ⌘1..9 workspaces, ⌘⇧R resume,
  ⌘⇧E send selection, ⌘↑/⌘↓ blocks). A new default chord must also be free in Monaco (it already binds
  Ctrl+Shift+A, C, G, I, K, L, M, O, R, Z; Settings → Keyboard warns on those via `usedByMonaco`).
  Holding exactly the workspace jump's modifiers (Ctrl / ⌘ by default) for 500 ms shows each
  row's digit; any other key cancels, so Ctrl shortcuts never flash it.
  Plain `Ctrl+<letter>` (incl. `Ctrl+R`), plain/Ctrl arrows and Escape belong to the shell;
  Escape is swallowed only while a block is selected. The chords above are defaults
  (`DEFAULT_CHORDS` in `lib/chords.ts`); the user's `keybindings` setting overrides or unbinds
  them and can bind any palette command. Everything reads the effective map
  (`currentBindings`), never a hardcoded key. Every user chord passes `stealsTerminalKey`
  (`lib/chordSpec.ts`): Escape, Tab, keys without Ctrl/Cmd, plain Ctrl keys other than digits,
  `, . ; ' =` and F-keys, plain/Ctrl arrows, and on macOS anything without ⌘ are refused in
  Settings → Keyboard and in `pine settings set` (keybindings aren't a grant, so agents may set
  them), and ignored if hand-edited in. Don't loosen that guard. All chord code lives in
  `lib/chords.ts` + `lib/chordSpec.ts`; xterm's `attachCustomKeyEventHandler` lets app chords
  through. Block navigation is a terminal chord (handled in xterm), never a window chord, so
  inputs and Monaco keep Shift/⌘+arrow selection. Show hints via `chordLabel()` /
  `useChordLabel()` (null when unbound).
- **Capabilities:** acting on any target other than your own pane/window/workspace needs
  `all-workspaces`. Agents can't grant themselves caps: `settings set` refuses `capabilities.*`
  and `approvals.*`; grants come only from a human editing `settings.json` or clicking an
  approval card (`main/approvals.ts`, answered only over `approvals:answer` IPC from the
  request's own window). Never add a command, socket method or CLI verb that answers,
  approves or pre-approves a request. A missing cap on the socket goes through `ensureCaps`
  (`controlElevation.ts`), never a bare throw, so the human gets asked. `destructive` always
  asks, even in `approvals.mode: 'allow'`, and never gets a session grant. Phone caps map through `PHONE_CAP_ALLOWS`;
  `input` must never map to a command capability. Phone grants (`command`, `input`,
  `destructive`) change only through the `gateway:set-cap` IPC from Settings →
  Remote; never add a control-socket method or CLI verb for them. `destructive` needs `command`
  and a confirm dialog.
- **Gateway:** off by default, loopback bind by default, never rotate the cert, reject requests
  with an `Origin` header, check `Host`, 1 MiB frame cap, 10 s hello deadline. Revocation closes
  live sockets AND re-checks the device on every request. Every frame uses the device's current
  caps from the store; removing a cap closes its live sockets (4004). Pty input and resize need
  an owner attachment plus `input`.
- **The phone contract still says "session".** Inside pine they are workspaces, but the gateway
  wire (`session.list` → `{ sessions }`, `sessionId` in panes, the `session.state` /
  `agent.*` events in `main/events.ts`) is the companion app's contract
  (`pine-companion/NETWORK-CONTRACT.md`). `controlDispatch.ts` maps `workspaceId` → `sessionId`
  at the boundary and drops sidebar-only fields (`groupId`). Rename the wire only together with
  the companion.
- **Attention goes through `reduceAttention`** (`lib/attention.ts`), dispatched via
  `attentionStore`/`signalPane`. Workspace state is derived from pane attention + running blocks by
  `startAttentionSync`; never `setState` a workspace's live state directly. A signal to the pane
  being viewed must apply `view` immediately (`signalPane` does), or it rings while you look at it.
- **Renderer attention commands act on the command target only** (`ctx.activePaneId`), never on
  a pane id in args: `command.exec` checks capabilities against the target, so an args pane id
  would bypass `all-workspaces`.
- **node-pty is loaded lazily and tolerated absent.**
- **What may live in core:** code that needs xterm or pty internals, or that every other feature
  depends on (windows, workspaces, panes, pty + shell integration, blocks, restore, command
  registry/palette/chords, attention/notifications, settings, control socket + capabilities,
  extension host). Everything else is an extension (`docs/ROADMAP.md` §2). Don't add a new
  feature module to `src/main` or a feature view to `src/renderer`; write an extension, and if
  the extension API can't express it, extend the API rather than special-casing core.
- **Extensions use only the public API.** Code in `src/extensions/**` imports only
  `src/extensions/sdk/` and `src/shared/`, never `src/main` or `src/renderer`, and reaches pine
  only through `ext.*` socket methods. Core never imports extension code; it knows an extension
  by its manifest.
- **Boards and knowledge belong to Trellis, not pine.** pine's kanban and wiki were removed; don't
  bring back a board, card or notes store in core or as a built-in. Agents use the `trellis` CLI;
  pine shows it through the `trellis` extension. Old `.pine/board.json`/`wiki.json` files are the
  user's data: never read, migrate or delete them.
- **Extension identities are not panes.** `controlServer` gates every method by caller kind
  (`callers`); new pane-scoped methods keep the default `panes`. An extension's caps are manifest
  ∩ human approval (`extensionStore.ts`), set with `setCaps` on each start. The one way an
  extension acts on a pane is a targetable method (`registerTargetableMethod`: `browse.*` in
  `browse.ts`, `process.*`, `pane.setAttention`) called with `targetPaneId`; it then needs the
  method's cap **and** `all-workspaces`, and runs as that pane. Never make a method targetable
  that types into a pane or waits on the human (`browse.pick`), and never drop the
  `all-workspaces` check: an extension owns no pane, so every target is another pane.
- **Extension settings are validated in main.** `extensions:set-setting` checks the value against
  the manifest's `contributes.settings` before anything is stored or sent to the extension; the
  renderer only persists what main returned (`extensionSettings` in `settings.json`, not in
  `DATA_KEYS`, so `pine settings set` can't write it). Stored values of the wrong type fall back
  to the default.
- **A palette argument is data for one extension command.** A command whose manifest declares
  `argument` gets the value the human typed in the palette only as `{argv: [value]}`, after main
  checks it (`ExtensionHost.paletteArgs` → `commandArgument`); it is never typed into a pane. A
  pane chip `url` (http/https only) is opened in the pane's workspace browser pane by the human's
  click, never by the extension.
- **Only the human approves or enables an extension** — the approval dialog or Settings, through
  `extensions:*` IPC. Never add a socket method or CLI verb that approves, enables, or changes an
  extension's caps. Hot reload (`ExtensionHost.rescan`, driven by `watchUserExtensions`) never
  writes `extensions.json`: a new user extension starts `pending-approval` and a manifest that
  asks for more runs with the approved subset.
- **Extension panels stay sandboxed.** Partition `pine-ext-<id>`, src and every navigation must
  pass `ExtensionHost.isAllowedPanelUrl` (a file inside the extension dir, or the loopback origin
  its process reported), no preload, permissions denied. A panel path (`ext.openPanel {path}`,
  `ext.notify {openPanel: path}`) is resolved to a URL in main (`resolvePanel`) and checked there,
  because changing a webview's `src` fires no `will-navigate`. A panel never gets `window.pine` or a
  token; it talks only to its own extension process.
- **Core surfaces stay tool-agnostic.** The `diff` surface shows two texts an extension hands it
  (`ext.openDiff`); it never runs git or reads a repo. Diff content lives in `diffStore` (memory),
  never in the layout node, and diff panes are dropped from `workspaces.json`.
- **Never run a user-configured program through a shell.** "Open in External Editor" splits
  `behavior.externalEditor` into argv, substitutes `{file}`/`{line}`/`{column}` per argument,
  and spawns with `shell: false` (`main/externalEditor.ts`). `settings.set` refuses to change
  that key (directly or via `behavior`); only the human sets it. `notifications.command` follows
  the same rule: `main/notifyCommand.ts` splits it into argv, substitutes `{title}` `{body}`
  `{pane}` per argument, spawns with `shell: false` for every recorded notification, and
  `settings.set` refuses it (directly or via `notifications`).
- **Settings sync never carries secrets or grants.** `SYNCED_FILES` (`settingsSync.ts`) is
  `settings.json` minus its local-only keys (`sync`, `capabilities`) and `extensions.json`. Never
  add the vault, `gateway-devices.json`, certificates or anything with a token. `sync` is not in
  the settings store's `DATA_KEYS`, so `pine settings set` can't point sync at a folder an agent
  controls; only Settings → Sync (the human) sets it.
- **Tool extensions never act for the human.** The keeper extension only runs the argv in
  `isAllowedKeeperCall` (`daemon status`, `approve --json`, `ui`); never pass a ticket to
  `keeper approve`, never start or restart its daemon. Anything that changes the user's data
  (`trellis init`) goes through `ext.confirm` first. An extension that starts a server
  (`trellis ui`) stops it in its `onShutdown` handler; one that found it already running leaves
  it alone. The system extension never runs a package manager itself: `pine system install`
  validates the names (`planInstall`), shows the exact command in `ext.confirm`, and only on
  Approve hands the argv to `ext.openTerminal`, so the human watches it and answers sudo.
  The git extension's discard is a panel-only handler (`panelHandlers` in
  `src/extensions/git/main.ts`) that runs only after `ext.confirm` lists the files; never make
  it a manifest command or a `pine git` verb. Agents may stage, unstage and commit (their own
  repo, what they staged). Every git call that takes paths passes `--literal-pathspecs`.
- **An extension types only into a terminal it just opened.** `ext.openTerminal` (needs `shell`)
  takes an argv, never a shell string; main quotes it (`shared/shellQuote.ts`) and the renderer
  opens a new pane and runs it once, at that pane's first idle prompt (`runWhenIdle`). Never add
  an extension method that types into an existing pane or accepts a raw command line.
- **Motion never touches the terminal's box.** Animate only `opacity` and `transform` (hover and
  focus feedback may transition colors, borders and shadows), with the tokens in `index.css`
  (`--motion-fast/base/slow`, `--ease-out/in`); no raw durations or easings. Never animate pane
  size, position or splits, the Allotment layout, or anything else that resizes an xterm host:
  each frame would fit and resize the pty and bring back the duplicated-prompt bugs (§6). The
  rail width transition is the one exception, and it is safe only because the terminal resize is
  debounced (`e2e/resize-prompt.spec.ts` toggles it). Attention is the only thing that pulses,
  and every pulse stops (ring ×2, waiting dot ×3); only the `working` dot breathes forever.
  Reduced motion (`appearance.motion`, `prefers-reduced-motion`) collapses motion but never hides
  state. Details: `docs/DESIGN.md` §8.
- **Saved passwords never leave main in plaintext** (`main/credentials.ts`). They're stored
  encrypted with `safeStorage` in the data dir (never synced), keyed by exact origin
  (`normalizeOrigin`, http/https only), and the renderer only ever gets summaries (origin,
  username); "copy" writes the clipboard from main. No socket method or CLI verb returns a
  password; filling a page happens in main, in `LOGIN_WORLD_ID`, only when the page's origin
  still equals the login's. `browse.login` needs the `credentials` capability, which always
  asks (`ALWAYS_ASK`) and never gets a session grant.
- **The file menu never launches programs.** "Open with default app" (`main/openPath.ts`) is
  confined like `fs:*` and refuses executables, scripts and launchers (`isProgram`); reveal only
  shows the item in the file manager. "Send path to agent" lists only agents running in the
  workspace (`runningAgent`).
- **User actions are data, and elevated ones ask once.** `actions` in `settings.json` name a
  palette command + args (`parseActions`), never a shell string; agents may add them. Running
  one whose command needs a non-default capability shows the command and args and waits
  for Run once / Run and trust (`runUserAction`); trust is keyed by command + args
  (`actionFingerprint`), stored in `trustedActions`, which only the dialog writes (not in
  `DATA_KEYS`, never synced). Never add a way for an agent to trust an action.
- **UI shows only real data.** No mock numbers, placeholder branches, or buttons that pretend to do
  something. If a feature isn't built, the UI doesn't show it.

---

## 5. Conventions

- **Biome** (lint + format + imports): 2-space, single quotes, no semicolons unless needed,
  `lineWidth: 100`.
- **TypeScript strict** (+ `noUnusedLocals`/`noUnusedParameters`). Prefix unused params with `_`.
  Aliases: `@/*` → `src/renderer/*`, `@shared/*` → `src/shared/*`.
- **Naming:** components `PascalCase.tsx`; stores/libs `camelCase.ts`; stores `useXStore`;
  generated shell symbols `__pine_*`.
- **zustand:** `create<State>((set, get) => ({ … }))`, immutable updates, cross-store via
  `useOtherStore.getState()`. Pure logic stays out of stores.
- **Model:** a **Workspace** (sidebar; `kind`, `workDir`, live `state`) owns a split-tree whose
  leaves are **Panes** or **tab stacks** of panes;
  each pane hosts one **Surface**: `terminal | editor | browser | extension | diff` (`agent` is
  reserved in the type and snapshot format, not yet created; `diff` is never persisted). An
  `editor` pane is a file view (`FileView.tsx`): images and PDFs get viewers, the rest Monaco.
- **UI:** shadcn primitives (on Base UI, not Radix) from `components/ui/` for buttons, inputs,
  selects, dialogs, tooltips, kbd, badges, alerts, empty states, list items and radio groups;
  hand-roll a control only when shadcn has none (pane tabs, block gutter, file tree, rail rows,
  window controls). Tokens and type scale in `docs/DESIGN.md`; never hardcode colors or
  off-scale font sizes. `--fg-dim` is never used for text. Icon-only buttons are `IconButton`.
  Icons come only from `@phosphor-icons/react` (`*Icon` names; weight set once by `IconContext`
  in `App.tsx`, never per icon). Extension panels (plain DOM) use `@phosphor-icons/core` SVGs
  through the SDK's `icon()`. No other icon family, no hand-drawn SVG icons, and no Unicode
  glyphs (`↻`, `×`) standing in for icons. Icons are never tinted with the brand color.
- **Motion:** overlays built on `components/ui/` get `motion-overlay` (or `motion-hint` for
  tooltips) and animate through Base UI's `data-starting-style`/`data-ending-style`; don't add
  tw-animate `animate-in`/`zoom-*`/`slide-*` classes. No scale on press, springs, bounces,
  staggered lists or page transitions.
- **Strings:** every user-visible string goes through `i18n/dict.ts` (en + zh-Hant).

---

## 6. Dragons (proven by past bugs — don't "fix" naively)

- **`BASH_B_MARK`** (`shellIntegration.ts`) is built with `String.raw` and interpolated as a value,
  single-quoted in the rc. An inline double-quoted copy let bash collapse `\]` and leak a `]`.
- **Bash preexec false positives:** the DEBUG trap fires for `PROMPT_COMMAND`'s own body. Guarded
  by `__pine_interactive_mode` and by running the user's `PROMPT_COMMAND` inside a function.
- **Ring-buffer trim boundary** (`ptyRingBuffer.ts`): cut just after the next `\n`, else the next
  `\x1b`. A raw slice severs an escape sequence and corrupts xterm on replay.
- **`pty:attach` race** (`Terminal.tsx`): subscribe to `onData` before `attach`, queue, flush after
  replay; reset the pane's blocks before replay so OSC 133 re-parse instead of duplicating.
- **Never fit a 0×0 host.** FitAddon computes 0 cols/rows and corrupts the pty. Never forward a 0×0
  or unchanged size. Debounce resize (~90 ms + rAF); cancel the rAF on unmount. A parked surface
  host is 0×0; that's why this guard matters.
- **Spawn the pty at the real fitted size**, never xterm's 80×24 default (prompt "staircase").
  `nextSizeAction()` decides attach/resize/noop; don't re-inline it.
- **Prompt-aware atomic resize** (`Terminal.tsx` `syncSize`/`flushHold`): at an idle prompt, resize
  the pty only, hold incoming bytes until the shell's repaint goes idle (~24 ms, 150 ms cap), then
  in one batch: erase from `min(prompt-marker row, cursor row)`, **move the cursor back to where
  the shell left it**, regrid to the captured dims, write the held repaint. Proven traps:
  (a) never erase without a repaint in hand (bash doesn't redraw on WINCH); (b) apply the captured
  dims, don't re-fit at flush; (c) zsh repaints with *relative* cursor moves, so skipping the
  cursor restore shifts the prompt up a row per resize and eats output above it; (d) the prompt
  row must come from an xterm marker, because reflow moves lines under a stored number.
  (e) if the held bytes contain OSC 133;C, the user submitted a command during the hold: they are
  command output, not a repaint, so write them without erasing (`isPromptRepaint`), else the
  prompt and the typed command vanish (an extension opening a split pane right before Enter did it).
  Covered by `e2e/resize-prompt.spec.ts` (split + drag-resize with output above the prompt).
- **Attention is silent during replay** (`Terminal.tsx` `replaying`): the attach replay buffer
  re-parses old OSC 9/777/99, BELs and failed OSC 133;D marks. Signals are dropped until
  `term.write(buffer, cb)` calls back, else every remount/restore re-raises old notifications.
- **Portaled surfaces don't bubble React events to their `Pane`.** SurfacePool portals each
  surface, so its React parent is SurfacePool. Pane activation uses native `mousedown`/`focusin`
  listeners on the frame; a React `onMouseDownCapture` there only saw header clicks.
- **Never gate webview-guest instrumentation on `listenerCount`.** Electron itself listens to a
  `<webview>` guest's `console-message` (to forward it to the element), so `listenerCount === 0`
  is never true and Pine's console/error buffers silently stayed empty. Browser guests are
  instrumented once at `did-attach-webview` via the `instrumentedGuests` WeakSet; the debugger
  attach is checked separately with `debugger.isAttached()`.
- **The shell reports each command line itself** (OSC 633;E, VS Code's convention: `\\` and
  `\xHH` escapes) from zsh's `preexec $1` / bash's latest history entry (only if it contains
  `$BASH_COMMAND`). Reading the command off the screen picks up a right-aligned RPROMPT and
  misses pasted text; the screen read is only the fallback for shells without the mark.
- **Codex hooks are trusted by hash, never by `--dangerously-bypass-hook-trust`**
  (`shellIntegration.ts` `codexHookArgs`). The bypass flag also runs the user's unreviewed
  hooks. `codexHookTrustHash` must match Codex's own `hook_hash` (a test pins a hash codex
  0.157 reported); a mismatch leaves Pine's hooks untrusted, not unsafe. Keep `--no-daemon`:
  in Codex's shared app-server, hooks report to whichever pane started that server.
- **Input editor suppression is keyed on the prompt's A marker** (`draft.promptLine`), never the
  draft object: zsh re-emits OSC 133;B on every prompt redraw (p10k async segments, WINCH), which
  replaces the draft and would bring the editor back over a shell line the user already handed
  text to. Submitting or handing off suppresses the current A marker; the next prompt lifts it.
  Place the editor from xterm's cursor, not the B mark: prompt frameworks (p10k) redraw
  without it and Ctrl+L moves the prompt, while the cursor always sits at the input position of
  an idle prompt whose line the editor keeps empty.
- **The shell reports its PATH and command names through a file, never the terminal**
  (`__pine_report_shell` → `$PINE_SHELL_STATE`, read by `pty:commands` and
  `pty:prompt-context`; lines: PATH, `VIRTUAL_ENV`, `CONDA_DEFAULT_ENV`, `KUBECONFIG`, names),
  and only when they changed. Keep the hook free of subprocesses. Sent as a ~12 KB OSC 633 from the first precmd, the report held up zsh startup by
  about 1.8 s under p10k's instant prompt, so commands typed at the first prompt ran late and
  restore specs lost their history.
- **The input editor's textarea text is transparent**; `.input-editor-highlight` draws the
  colored draft on top of it. Keep their font, padding, border width, line height, wrapping and
  scrollbar gutter identical, or the real caret and selection drift away from the drawn text.
  Both use the terminal's cell height as line height and a letter spacing that matches xterm's
  cell width, so the draft lines up with the grid it covers.
- **The input editor's root is transparent.** Only `.input-editor-line` and
  `.input-editor-chips` paint the terminal background; a background on the full-pane root hid
  every line of output.
- **OSC 7 is not percent-decoded**: hooks emit raw paths; decoding corrupts dirs like `100%20off`.
- **Workspace restore is two files from two processes** (`workspaceSnapshot.ts`): the renderer
  autosaves `workspaces.json` as you work; main writes `scrollback.json` every 5 s when output
  changed and again at `before-quit` (before the kill loop). Each write merges restored scrollback
  not yet replayed, else quitting before visiting a workspace erases its history.
- **Persist the serialized screen, never raw pty bytes** (`screenMirror.ts`). Raw bytes replay
  correctly only at the same geometry and state: zsh's PROMPT_SP left a `%` and p10k's
  cursor-positioned RPROMPT/clock redraws left `:41` fragments and duplicate prompts after a
  restart at another size. Every pty has a headless `ScreenMirror` fed every byte the ring gets
  (`feedPty`) and resized with it (`resizePty`, including the gateway path); saves store its
  `serialize()`, cut before the idle prompt (OSC 133;A marker). The saved text must stay
  width-independent: logical lines, gaps as spaces, SGR only, no cursor moves. Don't swap in
  `@xterm/addon-serialize`: its cursor-forward gaps and wrapped-row tricks only work at the exact
  width they were made at, and the pane size at replay isn't known (it split the clock and
  printed rows of dashes). The live ring stays raw for attach/remount replay (it carries the
  OSC 133 marks).
- **Restored scrollback is one-shot** (`takeRestoredScrollback`): pane ids get re-issued. It's
  pushed through the `PtySession` ring (so remounts replay it) and captured via `since(0)` before
  `addLiveSubscriber` (else it paints twice).
- **The restore seam leads with a bare OSC 133;D** so a command running at quit doesn't come back
  as a block that runs forever.
- **Settings load and `hydrate()` run before the first render** (`main.tsx`): restored terminals
  read settings once at mount (GPU renderer, cursor), so loading them later started restored
  panes on defaults. The first render must already see the restored workspaces (or none), else the work zone flashes the empty state and a pane mounted
  before hydration would spawn a pty that's orphaned a tick later.
- **Allotment is keyed by the child-id list**; its internal sizes go stale on structural changes.
- **xterm's viewport paints black by default.** `.xterm-host .xterm .xterm-viewport` is
  transparent and the host is painted with the terminal theme background.
- **Dispose the server-side connection when an extension process exits** (`extensionHost.ts`
  `onExit`). vscode-jsonrpc doesn't reject in-flight requests when the socket closes, so an
  invoke that crashed the process would otherwise hang until the 30 s request timeout.
- **The CLI reads stdin only for extension commands whose manifest says `stdin: true`.** Agent
  harnesses often leave stdin open; reading it unconditionally hangs every `pine <ext> …` call.
- **The user's CLIs have sharp edges** (`src/extensions/trellis`, `src/extensions/keeper`):
  trellis prints its JSON errors on **stderr** and `trellis version` appends an update notice
  after its JSON on stdout (parse the first line); `trellis ui` prints nothing when it serves in
  the foreground (ask `trellis daemon status --json` for the address); the trellis session cookie
  is exchanged only at `/`, so project deep links need the extension's token-injecting proxy.
  `keeper approve` and `keeper ui` auto-start the keeper daemon, so always gate them with
  `keeper daemon status` (which doesn't). `trellis events --consumer` doesn't advance the cursor
  by reading; `events ack` does, and a new consumer starts at 0 (prime it without notifying).
  Keeper's dashboard has no per-ticket route (`/r/:id` is a local request, not a ticket), so
  its notice opens `/approvals`. The trellis extension starts before the renderer reports its
  workspaces, so an event for a project it doesn't know re-lists the workspaces
  (`isOpenProject`) before being dropped; without that the first review notice after launch
  was lost.
- **E2E reads terminal text from the DOM renderer.** WebGL draws to a canvas, so `isolatedLaunch()`
  seeds `behavior.gpuAcceleration: false` (`DOM_RENDERER_SETTINGS`); a spec that seeds its own
  `settings.json` spreads it in. Only `terminal-webgl.spec.ts` runs the GPU renderer.
- **pty children inherit Electron's file descriptors**, listening sockets included (Playwright's
  and Chromium's debugging ports). The ports extension drops every socket its parent (pine's
  main process) also holds; without that each terminal "listened" on pine's own ports.
- **E2E must isolate both data dirs** (`e2e/dataHome.ts` → `isolatedLaunch()`): a fresh
  `XDG_DATA_HOME` (else a spec restores the previous spec's panes) and `--user-data-dir` (else a
  spec rewrites the developer's real `settings.json`, which has happened). It also sets
  `XDG_CONFIG_HOME` so the developer's own user extensions (and their approval dialog) stay out.

---

## 7. Testing

Vitest 2 (unit + component) + Playwright (E2E). Config: `vitest.config.ts`, `vitest.workspace.ts`.

- **node** project: `src/main/**`, `src/shared/**`, `src/cli/**`, `src/extensions/**`. Extension
  host integration tests spawn `test/fixtures/extensions/echo` over a real socket;
  `src/cli/cli.ext.e2e.test.ts` builds and drives the real git extension and the echo fixture
  (stdin, errors, `pine ext ls`) via the CLI; `extensionHost.v2.integration.test.ts` drives pane
  chips, settings, panel paths and `targetPaneId` through the echo fixture, and
  `extensionHost.reload.integration.test.ts` writes extensions into a temp user dir for hot reload; `src/main/builtinGitExtension.integration.test.ts`
  runs the built git extension against a temp repo (sidebar, changes, diff sides, symlinks,
  pane chips and their setting, log, blame, stage/unstage, commit, and discard through the
  panel API with a fake confirm);
  `src/main/builtinPortsExtension.integration.test.ts` bundles the ports extension into a temp
  dir and points it at real process trees (a node listener, a fake `ssh` under `script` for a
  foreground process group, a child that only inherited the host's listening socket);
  `cli.ext.e2e.test.ts` also drives `pine system info|install` with fake `pacman`/`apt`/`sudo`
  from `test/fixtures/system/bin/` (never the real ones) and a fake confirm; `e2e/system.spec.ts`
  answers the native dialog by stubbing `dialog.showMessageBox` via `app.evaluate`. Extension tests that need `src/main`
  live in `src/main` or `src/cli`, never under `src/extensions`.
  Tool extensions (trellis, keeper) are tested against fake `trellis`/`keeper` shell scripts in
  `test/fixtures/tools/bin/` put first on `PATH`, fed scrubbed real `--json` captures from
  `test/fixtures/tools/<tool>/`; never point a test at the real tools.
- **dom** project (jsdom, `test/setup.ts`): `src/renderer/**`. A typed `window.pine` fake
  (`test/mocks/pine.ts`, typed as `PineBridge`) breaks when the contract drifts.
- **E2E** (`e2e/`): anything rendering xterm or Monaco, or needing a real pty, a restart, or a crash.
  The app boots with no workspaces: a spec that needs a terminal starts with `openWorkspace(win)`
  (`e2e/helpers.ts`).
  `e2e/extensions.spec.ts` installs the `test/fixtures/extensions-e2e/hello` user extension
  (bundled with esbuild) and covers approval, a palette-opened file panel and a `pine <ext>` call;
  `e2e/extensions-v2.spec.ts` installs it while pine runs (hot reload) and covers its pane chip,
  a panel path and its setting. `e2e/tools.spec.ts` drives the trellis and keeper extensions
  against the fake CLIs (palette "Trellis: Open Card", notification clicks that open a card and
  Keeper's approvals page); `e2e/ports.spec.ts` checks the ports and ssh pane chips against a
  real listener and a fake `ssh`.
  `e2e/browser-agent.spec.ts` grants `browse`, reads the pane's `PINE_*` env from its shell and
  drives a local http page through the real `pine browse` CLI (snapshot refs, fill/click/type,
  find, eval, storage, cookies, network, tabs, `--json`); `e2e/browser-storage.spec.ts` checks the
  storage drawer shows and edits a page's cookies, local and session storage.

Rules:
- Reset state between tests: zustand stores are singletons; `setState(init, true)` in `afterEach`,
  reset id counters, reset every cross-referenced store.
- No stub tests. Every test asserts observable behavior tied to a requirement.
- A bug fix comes with a test that fails without the fix.
- Style model: `src/renderer/layout/tree.test.ts` (`describe(unit)`, `it('does X when Y')`).

---

## 8. Known gaps

- **Workspace restore is soft, not tmux.** Ptys are children of the Electron main process, so quit
  or crash kills every shell. What survives is layout + scrollback (at most ~5 s behind). True
  reattach needs a separate pty-host daemon; `PtySession`'s owner/observer + `since(cursor)` model
  is the seam for it. Don't describe the feature as "keeps your processes running".
- **fs containment is lexical.** `resolveSafe` (`pathGuard.ts`) confines `fs:*` to
  `[homedir(), userData]` and blocks `../` escapes, but a symlink inside home pointing outside is
  followed.
- **Phone grants are all-or-nothing per cap.** `input` lets a phone type into any pane it can
  attach, and there's no on-desktop approval of phone-initiated elevation requests (the contract
  allows it; only the Settings switches exist). Anyone with shell access to the desktop can still
  edit `gateway-devices.json` directly, same as `settings.json`.
- **Plugin light themes have no terminal palette or Monaco theme of their own.** Only `pine-light` does; a plugin theme falls back to the One Dark Vivid terminal palette, and Monaco follows the theme's `appearance`.
- **Latent:** `pluginsStore.load()` isn't in-flight idempotent (two concurrent calls double-fetch).

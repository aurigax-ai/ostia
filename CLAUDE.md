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
| `pnpm install:local` | `package` + `scripts/install-linux.sh` → `~/.local/share/pine/app` + desktop launcher + `~/.local/bin/pine` (the CLI outside Pine) | Updating the user's installed app |
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
  LSP processes, background processes, JSON stores, control socket, gateway. `windowBroker.ts`
  moves workspaces between the main window and detached windows and merges their snapshots.
- **preload** (`src/preload/index.ts`): the single `contextBridge` surface. Forwards only.
- **renderer** (`src/renderer/`): React 18, zustand stores, xterm.js, Monaco, cmdk. No Node access.
- **shared** (`src/shared/`): dependency-free types, the `PineBridge` IPC contract, capabilities.
- **cli** (`src/cli/index.ts`): the `pine` CLI. Panes get a `pine()` shell function that runs it
  with the app's own Electron binary (`ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI"`), so no
  system Node is needed.
- **extensions** (`src/extensions/`): built-in extensions (git, trellis, keeper, system, ports,
  assistant) +
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
  path from the file menu (`insertPathReference`, `@<path> `) follows the same rule. A prompt
  the human wrote in the assist composer follows the report rule (`canInsertReference`, text
  only, never Enter); a command suggestion from the composer, the input editor's `# ` hint or
  Ask's "Insert at prompt" goes through `insertCommand` without Enter, only when the human
  picks it. An assist suggestion never replaces a draft or runs anything on its own. The chat
  pane's code blocks and inline commands follow the same rules (`lib/chatActions.ts`): Insert at
  prompt uses `insertCommand` without Enter at an idle prompt, Send to agent follows the report
  rule, and Run in new terminal opens a new terminal tab in the workspace folder and runs the
  block once at its first idle prompt (`runWhenIdle`), only after the human confirmed the exact
  command (once per chat session; text with newlines or control characters always goes through
  the risky-paste dialog). Anything
  else goes to the clipboard. The one exception outside this rule is `manager.input`
  (`main/managerMethods.ts`): the manager may type text and named keys into any other pane,
  prompt or not, but only while the human has `manager.allowInput` on (Settings → Manager); it
  fails `input-off` otherwise. Never add another path that types into an existing pane.
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
  from the shell's prompt hook. Chips without a value are hidden (Settings → Prompt's preview shows
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
  shell (or a new group silently merges with a restored one). Each renderer also mints in its
  own random namespace (`lib/idNamespace.ts`, set in `initWindow` before anything is minted),
  because several windows mint at once; never mint ids before it is set or share a counter
  between windows.
- **Each window owns its own workspaces; main only brokers.** A renderer saves, lists and acts
  on its own workspaces only. A workspace (or a single pane) moves between windows only through
  `windows:detach` / `windows:return` (`main/windowBroker.ts`): main validates the handoff
  (`parseHandoff`), checks the sender owns every pane, rehomes the pane identities
  (`rehomePanes`, tokens kept) and pending approvals (`approvals.rehome`), holds the ptys
  (`holdPtys`) and only then lets the source release it (`release` / `releasePane`, which emit
  no `pane-closed`). The target adopts the same pane ids; the pty is never killed or respawned
  by a move. Never close and recreate panes to move them, and never let a renderer name
  another window. A moved pane's handoff carries its `origin` (source workspace, list index,
  group, the neighbor it sat beside), saved with the detached window; on return main routes it
  to the window that still holds that workspace (`planReturn`) and the renderer grafts it back
  (`graftNode`), else it becomes its own workspace at the old index. A pane never moves alone
  into or out of a sandboxed workspace (`crossesSandbox`); the last pane of a workspace moves
  the workspace. Drag-out (`lib/paneDrag.ts`) goes through the same `windows:detach`; a drop on
  another window is a landing the target reports (`windows:drop-pane`, only for its own
  workspace and pane) and the source claims once (`windows:landing`, `Landings`) before it
  hands the pane over with `windows:give`; the target never pulls a pane.
  Closing a detached window moves its workspaces back into the main window;
  closing the main window hides it to the tray (quits when close-to-tray is off). Main merges the per-window snapshots into one
  `workspaces.json` (`windowBook.ts`); a renderer never writes another window's workspaces.
  Every window, detached included, is created by `createWindow` with `baseWebPreferences()`.
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
  a workspace, or any pane or tab that has a running command, and `main/closeGuard.ts` confirms
  quit once for every window (it collects each window's running groups and shows one dialog);
  `before-quit` calls `preventDefault()` until approved, so the scrollback save and pty kill run
  once, after approval. Moving a workspace or pane to another window, and closing a detached
  window, never ask about commands (nothing stops); they ask only about unsaved files, which
  the new window reopens from disk. New workspace paths call `startNewWorkspace()` (placement
  and folder settings), never `addWorkspace` directly. E2E seeds `workspaces.confirmQuit: false`.
  Closing to the tray (`workspaces.closeToTray`, on by default, or a `--hidden` start;
  `main/tray.ts`) hides the window without asking, since nothing stops; only Quit (the tray menu or
  the palette's `app.quit`, which needs `destructive`) quits, and the tray's Quit shows the window
  first so `closeGuard` can still ask. The packaged app holds a single-instance lock: a second
  launch shows the running Pine instead (`--hidden` shows nothing); unpackaged runs (`pnpm dev`,
  E2E) take no lock.
- **Workspace/pane guards:** `closePane` emits `pane-closed` only if the pane existed; a
  workspace's `workDir` is the anchor for new panes and follows the project of its active pane
  (`setProject`, `lib/workspaceProjects.ts`); a pane's `cwd` wanders. With no panes left, the
  workspace keeps its last project (name, `projectDir`, `workDir`).
- **App chords must not steal terminal keys.** Linux/Windows: `Ctrl+Shift+P` palette,
  `Ctrl+Shift+B` sidebar, `Ctrl+,` settings, `Ctrl+Shift+U` jump to latest unread,
  `Ctrl+Shift+H` command history, `Ctrl+Shift+S` search saved workflows, `Ctrl+Shift+T` new
  workspace, `Ctrl+1..9` jump to a workspace,
  `Ctrl+=` / `Ctrl+Shift+-` / `Ctrl+0` zoom in / out / reset (zoom out is not `Ctrl+-`: readline
  binds that to undo, and the keybinding guard refuses it),
  `Ctrl+Shift+R` resume the pane's agent, `Ctrl+Shift+E` send a file view's selection to an
  agent, `Ctrl+Shift+J` assist composer, `Ctrl+Shift+C/V` copy/paste, `Ctrl+Shift+F` find,
  `Ctrl+Shift+↑/↓` previous/next block.
  macOS uses ⌘ (⌘= ⌘- ⌘0 zoom, ⌘⇧U unread, ⌘⇧H history, ⌘⇧S workflows, ⌘T new workspace, ⌘1..9 workspaces, ⌘⇧R resume,
  ⌘⇧E send selection, ⌘J assist composer, ⌘↑/⌘↓ blocks). A new default chord must also be free in Monaco (it already binds
  Ctrl+Shift+A, C, G, I, K, L, M, O, R, Z; Settings → Keyboard warns on those via `usedByMonaco`).
  Holding exactly the workspace jump's modifiers (Ctrl / ⌘ by default) for 500 ms shows each
  row's digit; any other key cancels, so Ctrl shortcuts never flash it.
  Plain `Ctrl+<letter>` (incl. `Ctrl+R`), plain/Ctrl arrows and Escape belong to the shell,
  except the human's opt-in `terminal.clipboardKeys: 'smart'` (Linux/Windows): Ctrl+C copies
  only while text is selected (else it interrupts as usual) and Ctrl+V pastes
  (`lib/clipboardKeys.ts`);
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
  extension host, and the declarative-view renderer that draws data-only views with core
  components). Everything else is an extension (`docs/ROADMAP.md` §2). Don't add a new
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
  to the default. An extension may change only its own keys, with `ext.setSetting` (same
  validation, `setOwnSetting`), so a panel control and Settings → Plugins edit one value; main
  broadcasts `extensions:settings-stored` and the renderer persists it. Never let it reach
  another extension's settings or a core setting.
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
- **Icon themes are images, loaded and checked in main.** `contributes.iconThemes` (VS Code's
  icon theme JSON) is read only by `main/iconThemes.ts` for an enabled extension: size caps,
  every file inside the extension dir after `realpath`, symlinked files refused, only image
  `iconPath`s. The renderer gets `data:` URLs over `iconThemes:load` and never names a path;
  font icon themes are not loaded. Never serve icon files through a protocol or `file://`.
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
  shows the item in the file manager. Every "send to agent" target list (file menu, selection
  and pick-element panels) comes from `useAgentTargets`: only panes in the workspace that are
  running an agent (`runningAgent`), never plain shells or other workspaces.
- **User actions are data, and elevated ones ask once.** `actions` in `settings.json` name a
  palette command + args (`parseActions`), never a shell string; agents may add them. Running
  one whose command needs a non-default capability shows the command and args and waits
  for Run once / Run and trust (`runUserAction`); trust is keyed by command + args
  (`actionFingerprint`), stored in `trustedActions`, which only the dialog writes (not in
  `DATA_KEYS`, never synced). Never add a way for an agent to trust an action.
- **A sandboxed workspace runs only wrapped.** Every pane shell and `pine process` of a
  sandboxed workspace is spawned through its sandbox host (`main/sandbox/`); if the sandbox can't
  start, nothing spawns (the pane shows the missing packages). The only unwrapped pane is a host
  pane whose one-time token main minted after the human approved that exact command
  (`hostPanes.ts`). Sandbox policy lives in main (`sandbox.json`, owner-window `sandbox:*` IPC);
  `sandbox` in `settings.json` is local-only and not in `DATA_KEYS`. Never add a socket method or
  CLI verb that turns a sandbox off, adds a read path, changes its Pine-access switches or answers
  a sandbox card. Sandbox requests (domain, port, secret, package) always ask, even in
  `approvals.mode: 'allow'`, and never become capability grants. A known-malicious package can
  only be allowed once. `pine vault get` is refused in a sandbox; values go through
  `pine secret get` and its card.
  The secret service never touches saved browser logins; those stay with `browse.login`.
- **A feature that needs a system program registers it** (`main/systemRequirements.ts`) and refuses
  to turn on while it's missing, showing the packages and an install that goes through the
  System extension (the human approves and types sudo). Never install silently.
- **Views are data, drawn by core, enabled only by the human.** A view
  (`~/.config/pine/views/<name>.json`) is read only by `main/viewHost.ts` (symlinks and files over
  64 KiB refused) and must pass `parseViewText` (`shared/views.ts`): known nodes and properties,
  http/https URLs only, bindings that are property paths with a fixed filter list, never code or
  HTML. `lookup` (`shared/viewBindings.ts`) reads own properties and indices only; don't add
  expression evaluation, method calls or a way to reach prototypes. A new file is `pending` and
  is drawn only after the human enables it in Settings → Views (`views:set-enabled` IPC, stored in
  `userData/views.json`); never add a socket method or CLI verb that enables a view (`pine view`
  is `list`, `validate`, `open`, `schema`). Buttons run palette commands only through
  `runCommandAction`, so elevated commands ask like user actions; URLs open only in the browser
  pane. The draw budget (`expandView`) keeps the last good render instead of drawing more.
- **Assist requests carry only what the human put in them** (`shared/assist.ts`). The renderer
  sends a draft the human typed, the code around the cursor they are editing, or, in Ask, only
  the context chips they switched on (recent output, selection, folder, pane chips) or the block
  they asked to explain; never terminal output on its own. A chat request may also carry the
  outcomes of tool calls, only from tools on in that chat and run under the chat tools rules
  below. Main normalizes every request
  (`normalizeAssistRequest`) and result (`normalizeAssistResult`), routes only to an enabled
  extension granted `assist` that reported the point `ready` (`ExtensionHost.assistRuntime`),
  and cancels on Stop, close or a newer keystroke. Nothing is offered until a provider is
  configured (the built-in assistant reports nothing ready while its provider is `none`), and
  the UI names the provider and model each feature uses (the status `label`).
- **Extension secrets stay in main and their extension.** `contributes.secrets` values are
  written only through `extensions:set-secret` (Settings → Plugins), encrypted with
  `safeStorage` in the data dir (`main/extensionSecrets.ts`), never in `settings.json`, never
  synced, never returned to the renderer (only `secretsSet`), and read only by the extension that
  declared the key (`ext.getSecret`). Never add a socket method or CLI verb that reads or writes
  one.
- **Chat sessions are saved by main, only what was sent.** `main/chatSessions.ts` writes one
  JSON file per session into the data dir (0600, never synced), normalized by
  `normalizeChatSession`, trimmed from the oldest turn past 512 KiB and evicted oldest-first past
  16 MiB / 500 sessions, and the renderer says so. Context stored with a message is exactly the
  text that was sent. `assistant.chatHistory` off keeps sessions in memory only. Messages keep
  the AI SDK `UIMessage` shape (typed parts): tool calls are `dynamic-tool` parts, denied and
  failed ones included, clipped (never dropped) past the part cap, and exported to Markdown.
- **Chat tools act only with the human's approval, through core.** The chat extension only
  declares the tools pine lists in the request (`dynamicTool` without `execute`); the renderer's
  chat transport runs every call (`lib/chatTools.ts`) and sends the outcome back, at most 8
  rounds per question, and Stop cancels the model, a waiting card and MCP calls together.
  `decideTool` (`lib/chatToolPermissions.ts`) is the only permission logic: read-only tools run
  without asking only inside the workspace folder (reading outside asks, grantable per chat);
  opening a file or URL and every MCP tool ask with Allow once / Allow for this chat / Deny;
  `write_file` (shown as a diff) and `propose_command` (Insert at prompt via `insertCommand`
  without Enter, or Run in new terminal via `runWhenIdle`, risky text through the risky-paste
  dialog) ask every time and are never granted. Grants live in memory per session, never saved
  or synced, and only the card's buttons create them; never add a setting, socket method or CLI
  verb that pre-approves a tool. Tool results reach the model only from tools the human left on
  in that chat's tools menu; never offer raw terminal output as a tool (`terminal_context` gives
  the folder and commands with exit codes only). File tools go through main
  (`main/chatFsTools.ts`): absolute paths, `resolveSafe` plus `realpath` confinement to the fs
  roots, the workspace folder unless the human approved `outside`, size caps, no binary, no write
  through a symlink. Skills are read by main only from `assistant.skillFolders` (symlinks, YAML
  aliases and files over 256 KiB refused) and loaded by `load_skill`; the model sees names and
  descriptions until it loads one. MCP servers (`assistant.mcpServers`, `main/mcpHost.ts`) are
  spawned from an argv with `shell: false` and a minimal env (never `PINE_TOKEN`) or reached over
  http(s), connected only when a chat or Settings asks, and main re-checks the server and tool on
  every call. `assistant` is not in `DATA_KEYS`, so `pine settings set` can't add a server or a
  skill folder; MCP tokens are secrets (`mcp-secrets.json`, `safeStorage`, never synced, never
  returned, set only through `chatTools:set-mcp-secret` for a key the human declared). Never let
  the extension execute a tool, spawn an MCP server or read a skill itself.
- **The manager is opened only from outside Pine.** `portal.open` (`main/portal.ts`) refuses any
  caller that `callerVerdict` (`main/portalCaller.ts`) finds inside Pine or can't check; there is
  no approval prompt behind it, so never loosen that check, skip it, or add a control-socket
  method, CLI verb or skill text that opens, finds or attaches to the manager. There is one
  manager and one mirror. The agent is spawned as the pane's process from an argv
  (`manager.agents` presets + the caller's args), never through a shell or typed at a prompt.
  Pine's view of it (`ManagerView`) is an attach-only observer: it never writes to or resizes the
  pty; the mirror owns input and size. `manager` settings are not in `DATA_KEYS`, and the manager
  workspace is never saved.
  The manager pane's identity is marked (`markManager`) and holds `MANAGER_CAPABILITIES` (every
  cap but `phone`, `gateway` and `destructive`, which still asks). `manager.*` socket methods use
  `callers: 'manager'`, so any other pane gets `not-available-to-pane` and never learns the
  manager exists; only the manager's `pine docs` lists them, and the worker `pine` skill, CLI
  usage and docs never mention them. Workers are ordinary panes typed through `openTerminal`
  (`runWhenIdle`), capped by `manager.limits` (live workers, spawns per 10 min, bus messages per
  minute). The manager gets its own plugin (`managerAgent.ts`: the `pine-manager` skill, the
  human's `manager.skills` folders, resume and state hooks), never the worker `pine` skill.
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
  each pane hosts one **Surface**: `terminal | editor | browser | extension | diff | chat | view`
  (`agent` is reserved in the type and snapshot format, not yet created; `diff` is never
  persisted; a `chat` pane stores only its session id; a `view` pane stores only its
  `viewName`). An
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
  tw-animate `animate-in`/`zoom-*`/`slide-*` classes. A floating card that isn't a Base UI popup
  gets `motion-enter`. No scale on press, springs (incl. smooth/spring scrolls), bounces,
  staggered lists, page transitions or decorative loops (spinners, shimmers). JS-driven motion
  follows `useReducedMotion()`; extension panels time transitions with `sdk/panel.css`'s
  tokens. `src/renderer/lib/motion.test.tsx` enforces the raw-timing and class rules.
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
- **Pane drops land on `.pane-drop-layer`, never on the surface.** Surfaces are portaled, so
  their drag events never reach `Pane`'s React handlers, and a `<webview>` swallows them; a
  frame-level `onDragOver` only ever saw the header and always chose the top zone. While a pane
  drag is on (`usePaneDnd.dragging`, set on `dragstart` or, for another window's drag, on
  `dragenter`), every pane renders a transparent layer over its body; zones come from the pane
  frame's rect (`dropZoneAt`). Drag-out compares the `dragend` point with the window in the
  drag's own coordinates (screen minus client, taken at `dragstart`, `endedOutside`), never
  `window.screenX`: synthetic drags report client coordinates as screen ones, and a refused
  drop inside the window also fires a `dragleave` with no `relatedTarget`.
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
  It reads the node's `sizes` only at mount (`defaultSizes`), so a size change the store makes
  (equalize, a remembered panel size) needs a remount: a new child list or a bumped `equalized`.
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
  (`isOpenProject`) and retries (`UNKNOWN_PROJECT_RETRIES`, 1 s apart) before being dropped;
  without that the first review notice after launch was lost.
- **E2E reads terminal text from the DOM renderer.** WebGL draws to a canvas, so `isolatedLaunch()`
  seeds `behavior.gpuAcceleration: false` (`DOM_RENDERER_SETTINGS`); a spec that seeds its own
  `settings.json` spreads it in. Only `terminal-webgl.spec.ts` runs the GPU renderer.
- **pty children inherit Electron's file descriptors**, listening sockets included (Playwright's
  and Chromium's debugging ports). The ports extension drops every socket its parent (pine's
  main process) also holds; without that each terminal "listened" on pine's own ports.
- **E2E must isolate both data dirs** (`e2e/dataHome.ts` → `isolatedLaunch()`): a fresh
  `XDG_DATA_HOME` (else a spec restores the previous spec's panes) and `--user-data-dir` (else a
  spec rewrites the developer's real `settings.json`, which has happened). It also sets
  `XDG_CONFIG_HOME` so the developer's own user extensions (and their approval dialog) stay out,
  and `HOME` to a temp folder whose `.zshrc`/`.bashrc` only set a `❯` prompt, plus a test git identity
  (`testHome`), so shells never run the developer's rc files or agents. Compare against the
  app's `app.getPath('home')`, never the test process's `homedir()`.

---

## 7. Testing

Vitest 2 (unit + component) + Playwright (E2E). Config: `vitest.config.ts`, `vitest.workspace.ts`.

- **node** project: `src/main/**`, `src/shared/**`, `src/cli/**`, `src/extensions/**`. Its
  global setup (`test/buildOnce.ts`) builds the CLI and built-in extensions once per run; tests
  never rebuild them (two files building into `out/extensions` at once raced). Vitest runs at
  most 8 workers (`vitest.config.ts`), so integration tests don't time out under load. Extension
  host integration tests spawn `test/fixtures/extensions/echo` over a real socket;
  `src/cli/cli.ext.e2e.test.ts` builds and drives the real git extension and the echo fixture
  (stdin, errors, `pine ext ls`) via the CLI; `extensionHost.v2.integration.test.ts` drives pane
  chips, settings, panel paths and `targetPaneId` through the echo fixture, and
  `extensionHost.reload.integration.test.ts` writes extensions into a temp user dir for hot reload; `src/main/builtinGitExtension.integration.test.ts`
  runs the built git extension against a temp repo (sidebar, changes, diff sides, symlinks,
  pane chips and their setting, log, blame, stage/unstage, commit, discard through the
  panel API with a fake confirm, and the graph over branches and a merge: scopes, paging, the
  `graphScope`/`changesView` settings written by the panel and followed from Settings, and
  chosen branches in `PINE_EXTENSION_DATA`); the graph's lane layout, file tree and scope
  planning are pure and unit-tested next to them (`src/extensions/git/*.test.ts`);
  `src/main/builtinPortsExtension.integration.test.ts` bundles the ports extension into a temp
  dir and points it at real process trees (a node listener, a fake `ssh` under `script` for a
  foreground process group, a child that only inherited the host's listening socket);
  `cli.ext.e2e.test.ts` also drives `pine system info|install` with fake `pacman`/`apt`/`sudo`
  from `test/fixtures/system/bin/` (never the real ones) and a fake confirm; `e2e/system.spec.ts`
  answers the native dialog by stubbing `dialog.showMessageBox` via `app.evaluate`. Extension tests that need `src/main`
  live in `src/main` or `src/cli`, never under `src/extensions`.
  `extensionHost.assist.integration.test.ts` drives the assist points, streaming, cancellation
  and secrets through `test/fixtures/extensions-assist/oracle`; the assistant extension's
  providers are tested against local fake OpenAI-compatible, Anthropic and model-runtime
  (unix socket) servers, never a real provider; `e2e/assistant.spec.ts` configures a fake
  OpenAI-compatible server in Settings and drives Ask and the composer;
  `e2e/assistant-chat.spec.ts` (fake server from `e2e/fakeProvider.ts`) opens the chat pane from
  the top-bar Assistant menu, runs a shell block in a new terminal, opens a path from an answer,
  finds the session after a restart, accepts terminal ghost text with Tab without running it,
  and turns terminal completion off in the menu; its chat tools spec reads a file without a
  card, denies then allows a write shown as a diff, and approves a tool from the fake stdio MCP
  server (`test/fixtures/mcp/fake-server.mjs`, run with the test's node). Chat sessions are
  tested in `src/main/chatSessions.test.ts` (caps, trim, eviction, delete). Chat tools: the
  permission logic in `src/renderer/lib/chatToolPermissions.test.ts`, the transport's tool loop
  (approval, deny, Stop, grants, MCP) in `src/renderer/lib/chatTransport.tools.test.ts`, the
  cards in `ChatToolPart.test.tsx`, confinement in `src/main/chatFsTools.test.ts`, skills in
  `src/main/chatSkills.test.ts`, MCP settings and session clipping in
  `src/shared/chatTools.test.ts`, `McpHost` against the fake MCP server in
  `src/main/mcpHost.integration.test.ts`, and the whole loop (fake provider streaming a tool
  call, the assistant extension, the fake MCP server) in
  `src/main/chatTools.integration.test.ts`. Never point a test at a real MCP server.
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
  `e2e/files-tree.spec.ts` installs the `test/fixtures/extensions-e2e/icons` VS Code-format icon
  theme, picks it in Settings → Files, and checks theme icons, compact folders, nesting and
  Hide in tree.
  `e2e/git-graph.spec.ts` opens Git: Show Graph on a repo with
  branches and a merge, checks the uncommitted row and keyboard selection, switches to all
  branches, toggles the tree view, and changes `changesView` in Settings → Plugins to see the
  panel follow.
  `e2e/views.spec.ts` writes view files into the isolated `XDG_CONFIG_HOME`, enables them in
  Settings → Views (one while pine runs, for hot reload), checks the sidebar view's live
  workspace names and a button that runs `workspace.new`, and opens the panel view from the
  palette; a second test drags the Board panel's splitter, closes and reopens it, and checks
  it comes back at that width, also after a restart (remembered panel size; the pure parts are
  in `src/renderer/layout/panelSize.test.ts`, storage in `src/renderer/lib/panelSizes.test.ts`,
  the store in `layoutStore.panelSize.test.ts`). Views' schema, bindings and draw budget are unit-tested in `src/shared/views*.test.ts`
  and `src/renderer/lib/view*.test.ts`, the loader in `src/main/viewHost.test.ts`, the CLI verbs
  in `src/cli/cli.e2e.test.ts`.
  `e2e/detached-windows.spec.ts` moves a workspace with a running command into a new window
  (output continues, title is the project), closes it back into the main window, restores a
  detached window after a restart, gets an approval card in a detached pane's own window,
  moves a pane out and back into its own workspace, drags a tab out (synthetic `dragstart`/
  `dragend` with screen coordinates, since xvfb has no real cross-window drag), drops a
  detached pane onto the main window (synthetic drop + dragend), and keeps the main window in
  the tray when a detached window closes. `e2e/pane-dnd.spec.ts` drags tabs with real
  Playwright drags to split right and down over a terminal, reorders a tab bar, merges an
  editor tab into a terminal's stack, and checks the drop layer covers a browser pane's page.
  `e2e/browser-agent.spec.ts` grants `browse`, reads the pane's `PINE_*` env from its shell and
  drives a local http page through the real `pine browse` CLI (snapshot refs, fill/click/type,
  find, eval, storage, cookies, network, tabs, `--json`); `e2e/browser-storage.spec.ts` checks the
  storage drawer shows and edits a page's cookies, local and session storage.
  `e2e/manager.spec.ts` runs the built CLI under `script` (a real tty) with `PINE_*` stripped and
  a fake agent (`test/fixtures/manager/bin/fake-agent`) first on `PATH`, against a Pine whose
  portal is at `PINE_PORTAL_SOCKET`; it also runs the CLI from a Pine pane to check the refusal.
  It also runs a bash manager through `pine manager spawn|read|input` against a fake worker, with
  `manager.allowInput` off and on, and checks a worker pane is refused.
  `e2e/tray.spec.ts` covers close-to-tray.

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
- **The manager's caller check can be escaped on purpose.** A process that double-forks, calls
  `setsid` and clears its environment is no longer a descendant of Pine, has no Pine tty and no
  `PINE_TOKEN`, so `pine <agent>` from it opens the manager. The check stops a confused or
  injected agent, not a determined process running as the same user.
- **Plugin light themes have no terminal palette or Monaco theme of their own.** Only `pine-light` does; a plugin theme falls back to the One Dark Vivid terminal palette, and Monaco follows the theme's `appearance`.
- **Sandboxes are not VMs.** bwrap/Seatbelt stop a misbehaving agent, not a kernel exploit. SBX-C58 (macOS loopback-only binding) runs only on macOS.
- **Latent:** `pluginsStore.load()` isn't in-flight idempotent (two concurrent calls double-fetch).

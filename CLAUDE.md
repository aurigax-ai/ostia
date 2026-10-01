# CLAUDE.md — pine (Terminal Workspace)

Rules for any agent (or human) changing this repo. Read this before touching code. This file holds
only rules: when you change an invariant, command, or convention, update its rule here. Each rule
names the file or symbol that enforces it; the mechanics and the "why" behind it live in the
Trellis vault under `architecture/` (start at `trellis vault show architecture/index`; search with
`trellis vault ls architecture`). When a change alters how something works, edit that entry.

| Doc | Holds |
|---|---|
| `PRODUCT.md` | Who it's for, principles, and the **Goals** table (built / partial / not started) |
| `docs/DESIGN.md` | Tokens, type scale, components, motion, a11y rules |
| `docs/EXTENSIONS.md` | Writing an extension: manifest, `ext.*` API, panels, views |
| `docs/ROADMAP.md` | Lean-core architecture (core / built-in extensions / plugins) and phased plan |
| `docs/CHROME.md` | Pairing agents with the user's real Chrome (Chrome DevTools MCP) vs Pine's browser |
| `docs/AGENT-HOOKS.md` | Wiring agent CLIs' own hooks to pane attention |
| Trellis board `PINE` (`.trellis`) | Cards, plus the vault: `architecture/*` holds how it's built, the module map, every "Why:" and the test map (`architecture/testing/test-map`) |
| this file | Rules you must follow while editing |

---

## 0. No code comments

**The code has no comments. Do not add any.** Not `//`, not `/* */`, not JSDoc, not `{/* */}` in
JSX, not in CSS, not in tests. Comments go stale and agents trust them over the code; that has
caused real bugs here.

- Names carry the *what*. Extract a well-named function or constant instead of writing a comment.
- The *why* goes in the matching Trellis vault entry under `architecture/` (a "Why:" note) or, if
  an agent editing that code must know it, in §4 / §6 of this file.
- Allowed: tool directives only (`biome-ignore`, `@ts-expect-error`, `/// <reference>`).
- Enforced: `pnpm lint` runs `node scripts/comments.mjs --check` and fails on any comment.
  `node scripts/comments.mjs` (no flag) strips them.
- Generated shadcn files in `src/renderer/components/ui/**` are exempt; hand-edit them only to swap
  animation classes (§5 Motion), their icons to Phosphor (§5 UI), or to wrap a component in
  `forwardRef` (React 18 drops `ref` on plain function components; `Input`, `InputGroupInput`).
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

- **main** (`src/main/*.ts`, `src/main/gateway/`, `src/main/sandbox/`): windows, ptys, fs (read +
  write, confined), LSP processes, background processes, JSON stores, control socket, gateway,
  sandboxes. `windowBroker.ts` moves workspaces between the main window and detached windows and
  merges their snapshots.
- **preload** (`src/preload/index.ts`): the single `contextBridge` surface. Forwards only.
- **renderer** (`src/renderer/`): React 18, zustand stores, xterm.js, Monaco, cmdk. No Node access.
- **shared** (`src/shared/`): dependency-free types, the `PineBridge` IPC contract, capabilities.
- **cli** (`src/cli/index.ts`): the `pine` CLI. Panes get a `pine()` shell function that runs it
  with the app's own Electron binary (`ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI"`), so no
  system Node is needed.
- **extensions** (`src/extensions/`): built-in extensions (git, trellis, keeper, system, ports,
  assistant, completions) + their SDK. Each runs as its own process and talks to pine only over the
  control socket (`docs/EXTENSIONS.md`); the host is `src/main/extensionHost.ts`. trellis and keeper
  wrap the user's own CLIs; their fake stand-ins for tests are `test/fixtures/tools/bin/`.
- **settings sync** (`src/main/settingsSync.ts` + `settingsSyncIpc.ts`): mirrors settings and
  extension choices through the folder in `sync.dir`.

Security baseline for every window (`baseWebPreferences()` in `src/main/index.ts`):
`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. External links go through
`openExternalSafe` (http/https/mailto only).

---

## 4. Invariants you must not break

### 4.1 Boundaries and core scope

- **Renderer has zero Node access.** New capability = type in `PineBridge` (`shared/types.ts`) →
  handler in `src/main/` → one-line forwarder in `src/preload/index.ts`.
- **main control modules never import `main/index.ts`.** Dependencies flow in via `register*` deps
  objects.
- **Core holds only what needs xterm/pty internals or what everything depends on** (windows,
  workspaces, panes, pty + shell integration, blocks, restore, command registry/palette/chords,
  attention/notifications, settings, control socket + capabilities, extension host, the
  declarative-view renderer). Everything else is an extension (`docs/ROADMAP.md` §2): never add a
  feature module to `src/main` or a feature view to `src/renderer`; if the extension API can't
  express it, extend the API rather than special-case core.
- **node-pty is loaded lazily and tolerated absent.**

### 4.2 Terminal, pty and input

- **The pty lives in main, keyed by pane id**, and outlives renderer remounts (`pty:attach` replays
  a capped buffer; `pty:detach` keeps it for `DETACH_GRACE_MS`). Lifecycle closures check
  `ptys.get(paneId) === entry` before touching the map. Reaping asks `orphanVerdict`
  (`main/ptyReaper.ts`): never reap a pty whose window is recovering (up to `RECOVERY_GRACE_MS`) or
  that `finishRecovery` holds. Every kill path calls `killPty(paneId, reason)` with a reason.
- **Diagnostics never log what the user sees or types** (`main/appLog.ts`): event fields only, free
  text through `redactSecrets` and clipped; never terminal output, pty input, env, tokens or
  settings values. Renderer reports arrive only over `diagnostics:report`, validated and
  rate-limited (`main/rendererReports.ts`). Keep the app and per-surface error boundaries; a new
  surface kind renders inside `SurfaceErrorBoundary` (`SurfacePool.tsx`).
- **Shell integration never touches dotfiles.** OSC 133 A/B/C/D + OSC 7 (zsh/bash,
  `shellIntegration.ts`) are the block/cwd source of truth; other shells run without them. zsh gets
  a generated `ZDOTDIR` (+ `PINE_ZDOTDIR_ORIG`), bash `--rcfile`; files live in
  `privateTmpDir('pine-shell-integration')` (0700, refused if a symlink or not ours). cwd flows out
  (terminal → pane → Files), never in.
- **Blocks are anchored by xterm markers, never line numbers** (`IMarker`, disposed on
  reset/unmount). Command text is read once at OSC 133;C and stored; output is read on demand from
  `buffer.normal` between C and D (`lib/blockText.ts`), never cached. The block overlay is
  `pointer-events: none` and never covers text cells: only the gutter (in the host's left padding)
  and the sticky header take the pointer.
- **Nothing types into a pane unless it's at an idle prompt** (open draft, nothing running). Never
  add another path that types into an existing pane; anything not listed here goes to the clipboard.
  - *Commands* (rerun, history insert, a picked workflow, a suggestion the human picks from the
    assist composer, the `# ` hint, Ask or chat) go through `insertCommand` (`lib/blockActions.ts`):
    needs `shell`, pastes via `term.paste`, no Enter. An assist suggestion never replaces a draft or
    runs anything on its own.
  - *References* (pick-element / send-selection reports, the file menu's `insertPathReference`, a
    prompt from the assist composer, chat's Send to agent) go through `canInsertReference`
    (`lib/sendPick.ts`), which also allows a running agent (`claude`/`codex` by `runningAgentOf`, or
    a command that reported `waiting`/`done`). Text only, never Enter.
  - *Human pastes*: dropped files paste as shell-quoted paths (`lib/dropPaths.ts`), never with
    Enter. Clipboard pastes go through `planHumanPaste` (`lib/pasteGate.ts`): one line is pasted
    without its trailing newline and control characters; more show the risky-paste dialog unless the
    human turned off `terminal.warnOnRiskyPaste`. That setting covers only human pastes; never let
    it reach a non-human source: generated text goes through `confirmsGeneratedText` and always asks
    on a newline or control character.
  - *Chat's Run in new terminal* (`lib/chatActions.ts`) opens a new tab in the workspace folder and
    runs the block once via `runWhenIdle`, only after the human confirmed the exact command.
  - *`manager.input`* (`main/managerMethods.ts`) may type text and keys into any other pane, prompt
    or not, only while the human has `manager.allowInput` on (else `input-off`).
- **The input editor never covers output, takes layout space or resizes the pty**
  (`InputEditor.tsx`, `behavior.inputMode: 'editor'`). It shows only at an idle prompt on the normal
  buffer; otherwise keys go straight to xterm. It submits through `insertCommand`; while it shows,
  `insertCommand` without Enter and keys, pastes and clicks aimed at xterm go to it
  (`inputEditorFor`), so the shell line stays empty. It is placed from xterm's cursor
  (`lib/promptOverlay.ts`) and covers only cells from the cursor on (plus the chip row). Keys it
  doesn't own hand the draft to the shell line as a bracketed paste, then send the key
  (`handOffInput`).
- **What main tells the editor about a shell is names and data only.** `pty:commands` and
  `pty:prompt-context` answer only the pane's own window; the renderer never names a directory or
  file (main chose `PINE_SHELL_STATE`). `pty:prompt-context` runs node only as
  `execFile(..., { shell: false })`, never from the prompt hook. Completion specs
  (`completions:spec`): the renderer sends a command name (`SPEC_COMMAND_PATTERN`); main
  (`main/completionSpecs.ts`) reads the user's folder, then enabled extensions'
  `contributes.completions`, refusing symlinks and files over `SPEC_FILE_MAX_BYTES`, and validates
  (`parseCompletionSpec`). Never ship or run Fig generators.
- **The Pine prompt changes only shells spawned while it's on** (`terminal.prompt.style: 'pine'`;
  `PINE_PROMPT`, `PINE_PROMPT_LINES` in the spawn env, applied after the user's rc). Never touch
  dotfiles or rewrite a running shell's prompt. Chips without a value are hidden, never
  placeholders.
- **A resume token is data, never a command.** `pine resume-token` stores `{agent, id}` only after
  `parseAgentResume` (known agent, id `[A-Za-z0-9._-]`); `resumeCommand` builds the command. It is
  typed only at an idle prompt when the human asks (Resume, `agent.resume`) or, with the human's
  `agents.autoResume`, for every pane whose agent ran at the last save, shown or not
  (`lib/autoResume.ts`); a command run in the pane first cancels it. Never store or replay a free-form
  command.
- **Main owns `agentRunning`** (`main/agentRunning.ts`): it survives Pine taking the shell away
  (reap, hibernation, quit, a broken renderer) and clears only when the agent's block ends or
  another command runs while attached (`pty:agent-running`), or the shell exits by itself. Never
  clear it on unmount, reset or reap.
- **Hibernation only stops what it can bring back** (`lib/hibernationScheduler.ts`, off by default):
  a pane with a resume token whose running block is that agent (`runningAgentOf`), not visible and
  idle past `idleSeconds`, or, when the human picks Hibernate agents on a workspace row
  (`hibernateWorkspace`), every such pane in it, shown or not; never a shell at a prompt, a
  non-agent command, or a pane without a token. Main stashes the screen first (`pty:hibernate`).
  Waking is only the human's act and types `resumeCommand` at the fresh shell's first idle prompt
  (`runWhenIdle`); revealing a pane never wakes it. `hibernated` is never persisted.
- **Attention goes through `reduceAttention`** (`lib/attention.ts`) via
  `attentionStore`/`signalPane`; workspace state is derived by `startAttentionSync`, never
  `setState` directly. A signal to the viewed pane applies `view` immediately. `waiting` is set only
  by an agent (`pine state waiting` while a command runs, OSC 9/777/99 while `runningAgent` finds
  one) or a pending approval; a plain command's notification is unread, never `waiting`. It ends on
  input, the next command, the end of the command that waited (`waitEnded`, `commandEnd`) or its
  approval leaving the queue; `view` keeps it. A late `waiting`/`working` report at an idle prompt
  is dropped (`isStaleAgentReport`).
- **Renderer attention commands act on the command target only** (`ctx.activePaneId`), never a pane
  id in args, which would bypass the `all-workspaces` check in `command.exec`.
- **Saved workflows are data, typed only by the human's pick.** Main alone reads and writes them
  (`main/workflows.ts`); callers name a workspace id, never a path. Symlinks, files over 64 KiB and
  YAML aliases are refused; every workflow (file or `contributes.workflows`) passes `parseWorkflow`.
  Saving writes a new file with `wx`, never overwriting. Never add a command, socket method or CLI
  verb that inserts, runs or saves a workflow: `pine workflow` is `list` and `show` only.
- **Selection reports are re-checked in main** (`selection:send` → `normalizeSelection`: kind,
  absolute path, clipped text, PNG signature, 25 MiB image cap, sender owns the source pane) and
  written only into `privateTmpDir('pine-reports')`, never next to the user's file. File viewers
  read bytes only through `fs.readBinary` (confined, 50 MiB cap).

### 4.3 Layout, windows and workspaces

- **Tabs are a leaf slot, never a split.** A `tabs` node holds only panes; splits and edge drops act
  on the whole stack, a center drop adds a tab, one tab left collapses to a pane. Whatever sets
  `activePaneId` shows that tab (`patch` runs `selectTab`); a background tab is not visible
  (`isPaneVisible`). Hidden tab bodies stay mounted (`visibility: hidden` + `inert`).
- **Surfaces never remount on split/move/zoom.** `SurfacePool` owns one persistent host per pane and
  always portals into it; the slot `appendChild`s the host. Never portal into the slot.
- **Layout tree transforms are pure** (`layout/tree.ts`): no React, no store access, same object
  back when nothing changed. `resetIds`/`adoptIds` are the only exceptions.
- **Counter ids are adopted on restore** (`adoptIds`, `adoptWorkspaceIds`, `adoptGroupIds`), and
  each window mints in its own random namespace (`lib/idNamespace.ts`, set in `initWindow`). Never
  mint before it is set or share a counter between windows.
- **Each window owns its own workspaces; main only brokers.** A renderer never names another window
  or writes its workspaces (main merges snapshots, `windowBook.ts`). Every window is made by
  `createWindow` with `baseWebPreferences()`.
  - Moves go only through `windows:detach` / `windows:return` / `windows:give`
    (`main/windowBroker.ts`): main validates (`parseHandoff`), checks the sender owns every pane,
    rehomes identities (`rehomePanes`) and approvals (`approvals.rehome`) and holds the ptys
    (`holdPtys`) before the source releases (no `pane-closed`). Pane ids are kept; a move never
    kills or respawns a pty. Never close and recreate panes to move them.
  - A returning pane goes back by its `origin` (`planReturn`, `graftNode`). A single pane never
    crosses into or out of a sandboxed (`crossesSandbox`) or scratch (`canMovePane`,
    `reportForeignDrop`) workspace; moving the last pane moves the workspace.
  - A drop on another window is reported by the target only for its own workspace and pane
    (`windows:drop-pane`); the source claims it once (`windows:landing`) and gives the pane. The
    target never pulls a pane.
  - Closing a detached window moves its workspaces to the main window; closing the main window hides
    it to the tray (quits when close-to-tray is off).
- **Workspace groups live on the flat workspace list**: a `groupId` on members, kept contiguous by
  `normalizeGroups` (`lib/workspaceGroups.ts`); empty groups are dropped. Never add a second member
  list or order. Pinned and grouped are exclusive. Deleting a group never closes a workspace.
- **Workspaces merge only on the human's confirm, never automatically.** Eligible only when they
  share a project path, neither is the manager, and their sandboxes are both off or identical
  (`lib/mergeEligibility.ts`). The human starts one from the row menu, the palette, or by dropping a
  workspace on the middle of an eligible row (`rowDropZone`); each asks the same confirm
  (`requestMergeWorkspace`). `workspace.mergeInto` is a `local` command (no socket method or CLI
  verb). Main re-checks (`workspace:merge`) and rehomes identities before `mergeLayouts`; panes keep
  ids and ptys, nothing remounts, no close events. A merged sandbox's host lives until its last
  confined process exits (`releaseMergedSandbox`).
- **Nothing live is ever restored.** A restored workspace comes back idle with a fresh shell at its
  saved cwd; scrollback is history. `processManager` loads running entries as exited, never
  restartable.
- **Scratch workspaces (`kind: 'scratch'`) leave nothing behind.** Never saved (`isRestorable`,
  `parseSnapshot`, no `scrollback.json`). Main alone makes the folder (`main/scratchFolders.ts`,
  `privateTmpDir('pine-scratch')`, 0700); the renderer never names it. Close deletes it (asking if
  it holds files), quit deletes all, startup sweeps dead ones. Shell history goes to the folder via
  `PINE_HISTFILE` (never a dotfile); history search, suggestions, chat sessions and the notification
  log keep its data in memory only. Create through `startScratchWorkspace()`.
- **Zero workspaces is valid.** Only the user (button, `workspace.new`, the chord, opening a file
  with none open) or restore creates one; never seed one at boot, on an empty restore or when the
  last closes. Every reader handles `activeWorkspaceId === null`; `workspaces: []` is saved and
  restored. New workspace paths call `startNewWorkspace()`, never `addWorkspace`.
- **A workspace may have no panes.** Nothing calls `ensure` on the user's behalf. Closing the last
  pane removes the layout and emits `pane-closed`; opening a file, browser, panel or diff in an
  empty workspace seeds it (`seedLayout`, only for an existing workspace). Saved without `root`.
- **Workspace/pane guards:** `closePane` emits `pane-closed` only if the pane existed. `workDir`
  anchors new panes and follows the active pane's project (`setProject`,
  `lib/workspaceProjects.ts`); with no panes left the workspace keeps its last project.
- **Closing and quitting ask only about running commands** (and a scratch folder's files):
  `lib/closeConfirm.ts` for workspaces/panes/tabs, `main/closeGuard.ts` once for all windows;
  `before-quit` calls `preventDefault()` until approved, so save and kill run once. Every quit Pine
  starts goes through `requestQuit()`; an unmarked quit is a signal and is approved without asking,
  exiting within 5 s (`main/quitPlan.ts`). Moving to another window and closing a detached window
  ask only about unsaved files. Close-to-tray (`workspaces.closeToTray`, default on, or `--hidden`;
  `main/tray.ts`) hides without asking; only Quit quits (`app.quit` needs `destructive`), and the
  tray's Quit shows the window first so `closeGuard` can ask. Packaged builds hold a single-instance
  lock; unpackaged runs don't. E2E seeds `workspaces.confirmQuit: false`.
- **App chords never steal terminal keys.** Defaults: `DEFAULT_CHORDS` (`lib/chords.ts`); code reads
  `currentBindings`, never a hardcoded key; hints come from `chordLabel()` / `useChordLabel()`. All
  chord code lives in `lib/chords.ts` + `lib/chordSpec.ts`.

  | Action | Linux/Windows | macOS |
  |---|---|---|
  | Palette · sidebar · settings | `Ctrl+Shift+P` · `Ctrl+Shift+B` · `Ctrl+,` | `⌘K` · `⌘\` · `⌘,` |
  | Latest unread · history · workflows | `Ctrl+Shift+U` · `Ctrl+Shift+H` · `Ctrl+Shift+S` | `⌘⇧U` · `⌘⇧H` · `⌘⇧S` |
  | New workspace · jump to workspace | `Ctrl+Shift+T` · `Ctrl+1..9` | `⌘T` · `⌘1..9` |
  | Zoom in · out · reset | `Ctrl+=` · `Ctrl+Shift+-` · `Ctrl+0` | `⌘=` · `⌘-` · `⌘0` |
  | Resume agent · send selection · assist composer | `Ctrl+Shift+R` · `Ctrl+Shift+E` · `Ctrl+Shift+J` | `⌘⇧R` · `⌘⇧E` · `⌘J` |
  | Copy · paste · find | `Ctrl+Shift+C` · `Ctrl+Shift+V` · `Ctrl+Shift+F` | `⌘C` · `⌘V` · `⌘F` |
  | Previous · next block (terminal chord) | `Ctrl+Shift+↑` · `Ctrl+Shift+↓` | `⌘↑` · `⌘↓` |

  - Plain `Ctrl+<key>` (incl. `Ctrl+R`, and `Ctrl+-`, readline's undo: that's why zoom out is
    `Ctrl+Shift+-`), plain/Ctrl arrows and Escape belong to the shell. The only exception is the
    human's opt-in `terminal.clipboardKeys: 'smart'` (`lib/clipboardKeys.ts`: Ctrl+C copies only
    with a selection, Ctrl+V pastes). Escape is swallowed only while a block is selected.
  - Every user chord (`keybindings`, which agents may set) passes `stealsTerminalKey`: Escape, Tab,
    keys without Ctrl/Cmd, plain Ctrl keys other than digits, `, . ; ' =` and F-keys, plain/Ctrl
    arrows, and on macOS anything without ⌘ are refused in Settings and `pine settings set` and
    ignored if hand-edited. Don't loosen that guard.
  - A new default must also be free in Monaco (`usedByMonaco`: Ctrl+Shift+A C G I K L M O R Z…).
  - Block navigation is a terminal chord (in xterm's `attachCustomKeyEventHandler`), never a window
    chord, so inputs and Monaco keep Shift/⌘+arrow selection.
  - Holding exactly the workspace jump's modifiers for 500 ms shows row digits; any key cancels.

### 4.4 Capabilities, security and remote

- **Capabilities:** acting on any target but your own pane/window/workspace needs `all-workspaces`.
  Agents can't grant themselves caps (`settings set` refuses `capabilities.*` and `approvals.*`):
  grants come only from the human editing `settings.json` or clicking an approval card
  (`main/approvals.ts`, answered only over `approvals:answer` from the request's own window). Never
  add a command, socket method or CLI verb that answers, approves or pre-approves a request. A
  missing cap on the socket goes through `ensureCaps` (`controlElevation.ts`), never a bare throw.
  `destructive` always asks, even in `approvals.mode: 'allow'`, and never gets a session grant.
- **Agents can't write the human's settings.** `pine settings set` writes only `DATA_KEYS`
  (`stores/settingsStore.ts`), plus `keybindings` through `stealsTerminalKey`. Outside it, human
  only: `capabilities`, `approvals`, `sync`, `extensionSettings`, `trustedActions`, `sandbox`,
  `manager`, `assistant`. `settings.set`/`unset` also refuse `PROGRAM_SETTINGS`
  (`commands/builtins.ts`: `behavior.externalEditor`, `notifications.command`, `agents.autoResume`,
  `terminal.warnOnRiskyPaste`), directly or via their group. Never bring one within an agent's
  reach.
- **Never run a user-configured program through a shell.** `behavior.externalEditor`
  (`main/externalEditor.ts`, `{file}` `{line}` `{column}`) and `notifications.command`
  (`main/notifyCommand.ts`, `{title}` `{body}` `{pane}`) are split into argv, substituted per
  argument and spawned with `shell: false`.
- **Gateway:** off by default, loopback bind by default, never rotate the cert, reject requests with
  an `Origin` header, check `Host`, 1 MiB frame cap, 10 s hello deadline. Revocation closes live
  sockets AND re-checks the device on every request; every frame uses the device's current caps;
  removing a cap closes its sockets (4004). Pty input and resize need an owner attachment plus
  `input`. Phone caps map through `PHONE_CAP_ALLOWS`; `input` never maps to a command capability.
  Phone grants change only via `gateway:set-cap` from Settings → Remote, never a socket method or
  CLI verb; `destructive` needs `command` and a confirm dialog.
- **The phone wire still says "session"** (`session.list`, `sessionId`, `session.state` / `agent.*`
  in `main/events.ts`; `pine-companion/NETWORK-CONTRACT.md`). `controlDispatch.ts` maps
  `workspaceId` → `sessionId` and drops sidebar-only fields. Rename it only with the companion.
- **Settings sync never carries secrets or grants.** `SYNCED_FILES` (`settingsSync.ts`) is
  `settings.json` minus local-only keys (`sync`, `capabilities`) and `extensions.json`. Never add
  the vault, `gateway-devices.json`, certificates or anything with a token.
- **Saved passwords never leave main in plaintext** (`main/credentials.ts`, `safeStorage`, never
  synced, keyed by exact http/https origin via `normalizeOrigin`). The renderer gets only origin +
  username; copy writes the clipboard from main. No socket method or CLI verb returns a password.
  Filling runs in main in `LOGIN_WORLD_ID`, only while the page's origin equals the login's.
  `browse.login` needs `credentials`, which always asks (`ALWAYS_ASK`), never a session grant.
- **The file menu never launches programs.** Open with default app (`main/openPath.ts`) is confined
  like `fs:*` and refuses executables, scripts and launchers (`isProgram`). Every "send to agent"
  target list comes from `useAgentTargets`: only panes in the workspace running an agent, never
  plain shells or other workspaces.
- **User actions are data; elevated ones ask once.** `actions` name a palette command + args
  (`parseActions`), never a shell string; agents may add them. One needing a non-default cap waits
  for Run once / Run and trust (`runUserAction`); trust (`actionFingerprint` in `trustedActions`) is
  written only by that dialog and never synced. Never add a way for an agent to trust one.
- **A sandboxed workspace runs only wrapped.** Every pane shell and `pine process` spawns through
  its sandbox host (`main/sandbox/`); if it can't start, nothing spawns. The only unwrapped pane is
  a host pane whose one-time token main minted after the human approved that exact command
  (`hostPanes.ts`). Policy lives in main (`sandbox.json`, owner-window `sandbox:*` IPC). Never add a
  socket method or CLI verb that turns a sandbox off, adds a read path, changes its Pine-access
  switches or answers a sandbox card. Sandbox requests always ask, even in
  `approvals.mode: 'allow'`, and never become capability grants; a known-malicious package can be
  allowed only once. `pine vault get` is refused in a sandbox (use `pine secret get` and its card);
  the secret service never touches saved browser logins.
- **A feature that needs a system program registers it** (`main/systemRequirements.ts`) and refuses
  to turn on while it's missing, offering an install through the System extension. Never install
  silently.
- **Page scripts run in isolated worlds** (`executeJavaScriptInIsolatedWorld`). Pick element
  (`PICK_WORLD_ID`, counts only `isTrusted` events) and `pine browse` element work
  (`BROWSE_WORLD_ID`, `shared/browseRuntime.ts`) never run in the page's main world; only `eval`,
  `wait --fn`, `pushstate`, the dialog override and `react-grab` do. `pickRuntime` and
  `browseRuntime` stay self-contained (shipped with `toString()`: no imports or module-level
  references). Agent strings reach generated JS only as `JSON.stringify`-ed arguments; output and
  upload paths go through `resolveSafe`. Captures are truncated in main (`normalizeCapture`), the
  renderer returns only a capture id, reports go to `privateTmpDir('pine-reports')`. Browse verbs
  follow agent-browser's contract (`cli/browseArgs.ts`); rename one there, in `docs.ts` and in the
  skill together.
- **The storage viewer touches only the human's own pane** (`browser:storage-*` via `ownedGuest`,
  every edit and removal validated in main by `normalizeStorageEdit`/`normalizeStorageRemoval`;
  clear-all confirmed first).
- **The manager is opened only from outside Pine.** `portal.open` (`main/portal.ts`) refuses any
  caller `callerVerdict` (`main/portalCaller.ts`) finds inside Pine or can't check; there is no
  approval behind it, so never loosen or skip it, and never add a socket method, CLI verb or skill
  text that opens, finds or attaches to the manager.
  - One manager, one mirror. Its agent is spawned from an argv (`manager.agents` + the caller's
    args), never through a shell or a prompt. `ManagerView` only observes: it never writes to or
    resizes the pty. The manager workspace is never saved.
  - Its pane (`markManager`) holds `MANAGER_CAPABILITIES` (all but `phone`, `gateway`,
    `destructive`, which still asks). `manager.*` methods use `callers: 'manager'`; other panes get
    `not-available-to-pane` and never learn the manager exists. Only the manager's `pine docs` lists
    them; the worker `pine` skill, CLI usage and docs never mention them.
  - Workers are ordinary panes typed via `openTerminal` (`runWhenIdle`), capped by `manager.limits`
    (live workers, spawns per 10 min, bus messages per minute). The manager gets its own plugin
    (`managerAgent.ts`: the `pine-manager` skill, the human's `manager.skills`, resume and state
    hooks), never the worker `pine` skill.

### 4.5 Extensions and views

- **Extensions use only the public API.** `src/extensions/**` imports only `src/extensions/sdk/` and
  `src/shared/` and reaches pine only through `ext.*` socket methods. Core never imports extension
  code; it knows an extension by its manifest.
- **Only the human approves or enables an extension** (the approval dialog or Settings, via
  `extensions:*` IPC). Never add a socket method or CLI verb that approves, enables or changes an
  extension's caps. Hot reload (`ExtensionHost.rescan`) never writes `extensions.json`: a new
  extension starts `pending-approval`; a manifest asking for more runs with the approved subset.
- **Only the human installs an extension, and installing never runs or approves it**
  (`main/marketplace.ts`, `marketplace:*` IPC from Settings → Extensions). A marketplace is a git
  repository with `pine-marketplace.json`; its URL passes `normalizeMarketplaceUrl` (https, ssh,
  `owner/repo` or an absolute folder) and reaches `git clone` as an argv after `--`, `shell: false`,
  no submodules, `core.symlinks=false`. Install only copies regular files (`planCopy`; no symlinks,
  size caps, `pine.json` last) into the user extensions folder; never run a build, a package manager
  or a script from one. A fresh install and an uninstall drop the id's approval and secrets
  (`forget`), so it always starts `pending-approval`; an id used by a built-in, a hand-installed
  extension or another marketplace is never overwritten, and uninstall removes only what the
  marketplace installed. Never add a socket method or CLI verb that adds a marketplace or installs,
  updates or uninstalls an extension, and never sync `marketplaces.json`.
- **Extension identities are not panes.** `controlServer` gates methods by caller kind (`callers`;
  new pane-scoped methods keep `panes`). Caps are manifest ∩ human approval (`extensionStore.ts`,
  `setCaps` on each start). An extension acts on a pane only through a targetable method
  (`registerTargetableMethod`) with `targetPaneId`, needing the method's cap **and**
  `all-workspaces`. Never make a method targetable that types into a pane or waits on the human
  (`browse.pick`), and never drop the `all-workspaces` check.
- **An extension types only into a terminal it just opened.** `ext.openTerminal` (needs `shell`)
  takes an argv, never a shell string; main quotes it (`shared/shellQuote.ts`) and it runs once at
  the new pane's first idle prompt (`runWhenIdle`). Never add a method that types into an existing
  pane or accepts a raw command line.
- **Extension settings are validated in main** against `contributes.settings`
  (`extensions:set-setting`, and `ext.setSetting` → `setOwnSetting` for the extension's own keys)
  before they're stored or sent; the renderer persists only what main returned; wrong-typed stored
  values fall back to the default. Never let an extension reach another's settings or a core one.
- **Extension secrets stay in main and their extension.** Written only via `extensions:set-secret`
  (Settings → Extensions / Assistant), `safeStorage`-encrypted (`main/extensionSecrets.ts`), never in
  `settings.json`, never synced, never returned to the renderer (only `secretsSet`), read only by
  the declaring extension (`ext.getSecret`). Never add a socket method or CLI verb for them.
- **A palette argument is data for one command**: delivered only as `{argv: [value]}` after main
  checks it (`ExtensionHost.paletteArgs` → `commandArgument`), never typed into a pane. A pane chip
  `url` or a chip item's url (http/https, `paneChipItems`) opens in the workspace's browser pane
  only on the human's click; a chip `icon` must be in `EXTENSION_ICONS`.
- **Extension panels stay sandboxed.** Partition `pine-ext-<id>`, no preload, permissions denied;
  src and every navigation pass `ExtensionHost.isAllowedPanelUrl`. Panel paths are resolved and
  checked in main (`resolvePanel`), since a `src` change fires no `will-navigate`. A panel never
  gets `window.pine` or a token; it talks only to its own extension process.
- **Icon themes (`contributes.iconThemes`) are images checked in main** (`main/iconThemes.ts`,
  enabled extensions only: size caps, files inside the extension dir after `realpath`, no symlinks,
  image `iconPath`s only). The renderer gets `data:` URLs over `iconThemes:load`, never a path; font
  themes aren't loaded. Never serve icon files through a protocol or `file://`.
- **Core surfaces stay tool-agnostic.** The `diff` surface shows two texts from `ext.openDiff`; it
  never runs git or reads a repo. Diff content lives in `diffStore`, never in the layout node or
  `workspaces.json`.
- **Tool extensions never act for the human.**
  - keeper runs only `isAllowedKeeperCall` argv (`daemon status`, `approve --json`, `ui`): never
    pass a ticket to `keeper approve`, never start or restart its daemon.
  - Changing the user's data (`trellis init`) needs `ext.confirm` first. A server an extension
    started (`trellis ui`) stops in `onShutdown`; one it found running stays.
  - The system extension never runs a package manager: `pine system install` validates
    (`planInstall`), shows the exact command in `ext.confirm`, and only on Approve opens it with
    `ext.openTerminal` for the human to watch and answer sudo.
  - git's discard is a panel-only handler (`panelHandlers`, `src/extensions/git/main.ts`) run only
    after `ext.confirm` lists the files; never a manifest command or `pine git` verb. Agents may
    stage, unstage and commit. Every git call that takes paths passes `--literal-pathspecs`.
- **Boards and knowledge belong to Trellis.** Never bring back a board, card or notes store in core
  or as a built-in. Old `.pine/board.json`/`wiki.json` files are the user's: never read, migrate or
  delete them.
- **Views are data, drawn by core, enabled only by the human.** `main/viewHost.ts` alone reads
  `~/.config/pine/views/<name>.json` (no symlinks, ≤ 64 KiB); each passes `parseViewText`
  (`shared/views.ts`: known nodes and properties, http/https URLs, property-path bindings with a
  fixed filter list; never code or HTML). `lookup` (`shared/viewBindings.ts`) reads own properties
  and indices only: no expressions, method calls or prototype access. A new view is `pending` until
  enabled in Settings → Views (`views:set-enabled`); never add a socket method or CLI verb that
  enables one (`pine view` is `list`, `validate`, `open`, `schema`). Buttons run commands only via
  `runCommandAction`; URLs open only in the browser pane; past the draw budget (`expandView`) the
  last good render stays.

### 4.6 Assistant and chat

- **Assist requests carry only what the human put in them** (`shared/assist.ts`): their draft, the
  code around their cursor, the Ask chips they switched on (recent output, selection, folder, pane
  chips) or the block they asked about, and in chat the outcomes of tools they left on; never
  terminal output on its own. Main normalizes requests and results
  (`normalizeAssistRequest`/`normalizeAssistResult`), routes only to an enabled extension granted
  `assist` that reported the point `ready` (`ExtensionHost.assistRuntime`), and cancels on Stop,
  close or a newer keystroke. Nothing is offered until a provider is configured; the UI names each
  feature's provider and model.
- **The assistant is configured only in Settings → Assistant** (`AssistantSection.tsx`), never an
  extension panel. Model load/unload reach the extension only as `ext.assistModels` from there, for
  an enabled `assist` extension that reported `models: true` (`normalizeAssistModels`).
- **Chat sessions are saved by main, only what was sent** (`main/chatSessions.ts`: one file per
  session, 0600, never synced, `normalizeChatSession`, trimmed past 512 KiB, evicted past 16 MiB /
  500). Stored context is exactly the text sent. `assistant.chatHistory` off keeps them in memory.
  Messages keep the AI SDK `UIMessage` shape; tool calls are `dynamic-tool` parts (denied and failed
  too), clipped past the part cap, never dropped.
- **Chat tools act only with the human's approval, through core.** The extension only declares the
  tools pine lists (`dynamicTool` without `execute`, or `tools: 'prompted'`,
  `src/extensions/assistant/promptedTools.ts`); never let it execute a tool, spawn an MCP server or
  read a skill.
  - The renderer runs every call (`lib/chatTools.ts`), at most 8 rounds; Stop cancels everything.
  - `decideTool` (`lib/chatToolPermissions.ts`) is the only permission logic: read-only tools run
    unasked only inside the workspace folder; opening a file/URL and every MCP tool ask;
    `write_file` and `propose_command` ask every time and are never granted. Grants live in memory
    per session, never saved or synced, created only by the card's buttons; never add a setting,
    socket method or CLI verb that pre-approves a tool. Tool results reach the model only from tools
    the human left on in that chat. Never offer raw terminal output as a tool (`terminal_context`
    gives the folder and commands with exit codes only).
  - File tools go through main (`main/chatFsTools.ts`): absolute paths, `resolveSafe` + `realpath`
    confinement, the workspace folder unless the human approved `outside`, size caps, no binary, no
    write through a symlink. Skills: main reads only `assistant.skillFolders` (no symlinks or YAML
    aliases, ≤ 256 KiB), loaded by `load_skill`.
  - MCP servers (`assistant.mcpServers`, `main/mcpHost.ts`) spawn from an argv with `shell: false`
    and a minimal env (never `PINE_TOKEN`) or use http(s), connect only when a chat or Settings
    asks, and are re-checked on every call. MCP tokens are secrets (`mcp-secrets.json`,
    `safeStorage`, never synced or returned), set only via `chatTools:set-mcp-secret` for a key the
    human declared.

### 4.7 UI and motion

- **UI shows only real data.** No mock numbers, placeholder branches, or buttons that pretend to do
  something. If a feature isn't built, the UI doesn't show it.
- **Motion never touches the terminal's box.** Animate only `opacity` and `transform` (hover and
  focus may transition colors, borders, shadows), with the `index.css` tokens
  (`--motion-fast/base/slow`, `--ease-out/in`), never raw durations or easings. Never animate pane
  size, position or splits, Allotment, or anything that resizes an xterm host. The one exception is
  the rail collapse transition (safe only because terminal resize is debounced;
  `e2e/resize-prompt.spec.ts`); dragging the rail edge never animates (`data-rail-resizing`). Only
  attention pulses, and every pulse stops (ring ×2, waiting dot ×3); only the `working` dot breathes
  forever. Reduced motion (`appearance.motion`, `prefers-reduced-motion`) collapses motion but never
  hides state. `docs/DESIGN.md` §8.

---

## 5. Conventions

- **Biome** (lint + format + imports): 2-space, single quotes, no semicolons unless needed,
  `lineWidth: 100`.
- **TypeScript strict** (+ `noUnusedLocals`/`noUnusedParameters`). Prefix unused params with `_`.
  Aliases: `@/*` → `src/renderer/*`, `@shared/*` → `src/shared/*`.
- **Naming:** components `PascalCase.tsx`; stores/libs `camelCase.ts`; stores `useXStore`; generated
  shell symbols `__pine_*`.
- **zustand:** `create<State>((set, get) => ({ … }))`, immutable updates, cross-store via
  `useOtherStore.getState()`. Pure logic stays out of stores.
- **Model:** a **Workspace** (sidebar; `kind`, `workDir`, live `state`) owns a split-tree whose
  leaves are **Panes** or **tab stacks**; each pane hosts one **Surface**:
  `terminal | editor | browser | extension | diff | chat | view | manager` (`agent` is reserved, not
  yet created). `diff` and `manager` are never persisted; a `chat` pane stores only its session id,
  a `view` pane only its `viewName`. An `editor` pane is a file view (`FileView.tsx`): images and
  PDFs get viewers, the rest Monaco.
- **UI:** shadcn primitives (on Base UI, not Radix) from `components/ui/`; hand-roll a control only
  when shadcn has none (pane tabs, block gutter, file tree, rail rows, window controls). Tokens and
  type scale in `docs/DESIGN.md`; never hardcode colors or off-scale font sizes. `--fg-dim` is never
  used for text. Icon-only buttons are `IconButton`.
- **Icons** only from `@phosphor-icons/react` (`*Icon` names; weight set once by `IconContext` in
  `App.tsx`, never per icon); extension panels use `@phosphor-icons/core` via the SDK's `icon()`. No
  other family, no hand-drawn SVG icons, no Unicode glyphs (`↻`, `×`) as icons, never tinted with
  the brand color.
- **Motion:** overlays on `components/ui/` get `motion-overlay` (`motion-hint` for tooltips) and
  animate through Base UI's `data-starting-style`/`data-ending-style`; no tw-animate
  `animate-in`/`zoom-*`/`slide-*`. A floating card that isn't a Base UI popup gets `motion-enter`.
  No scale on press, springs (incl. smooth scrolls), bounces, staggered lists, page transitions or
  decorative loops (spinners, shimmers). JS motion follows `useReducedMotion()`; extension panels
  use `sdk/panel.css`'s tokens. Guard: `src/renderer/lib/motion.test.tsx`.
- **Typography:** sizes `text-ui-xs|sm|base|emphasis|lg` (CSS `var(--text-ui-*)` with
  `var(--text-ui-*--line-height)`), families `font-sans`/`var(--font-ui)` and, for machine text
  only, `font-mono`/`var(--font-code)`, weights `font-normal|medium|semibold`
  (`var(--font-weight-*)`), `tracking-caps` for all-caps labels. Never set a font size, family,
  weight, line height or letter spacing outside the tokens (guard:
  `src/renderer/lib/typography.test.ts`). UI fonts follow settings via the font tokens
  (`lib/uiFonts.ts`; panels `--pine-font-*`). `docs/DESIGN.md` §4.
- **Strings:** every user-visible string goes through `i18n/dict.ts` (en + zh-Hant).

---

## 6. Dragons (proven by past bugs — don't "fix" naively)

The trap, the rule, the guard. Full stories: the Trellis vault's `architecture/` entries.

**Shell integration**
- **`BASH_B_MARK`** is built with `String.raw` and interpolated single-quoted; an inline
  double-quoted copy let bash collapse `\]` and leak a `]`.
- **Bash's DEBUG trap fires for `PROMPT_COMMAND`'s own body.** Keep the `__pine_interactive_mode`
  guard and run the user's `PROMPT_COMMAND` inside a function.
- **The shell reports each command line itself** (OSC 633;E, `\\`/`\xHH`; zsh `preexec $1`, bash
  history only if it contains `$BASH_COMMAND`). The screen read (RPROMPT, misses pastes) is only the
  fallback for shells without the mark.
- **PATH and command names go through a file, never the terminal** (`__pine_report_shell` →
  `$PINE_SHELL_STATE`), only when changed, from a hook with no subprocesses. As an OSC it delayed
  zsh startup ~1.8 s under p10k.
- **OSC 7 is not percent-decoded**: decoding corrupts dirs like `100%20off`.
- **Codex hooks are trusted by hash, never `--dangerously-bypass-hook-trust`** (`codexHookArgs`; the
  flag also runs unreviewed user hooks). `codexHookTrustHash` must match Codex's `hook_hash` (pinned
  by a test); a mismatch leaves them untrusted, not unsafe. Keep `--no-daemon`.

**pty, xterm and resize**
- **Ring-buffer trim** (`ptyRingBuffer.ts`) cuts just after the next `\n`, else the next `\x1b`; a
  raw slice severs an escape sequence.
- **`pty:attach` race** (`Terminal.tsx`): subscribe `onData` before `attach`, queue, flush after
  replay; reset the pane's blocks before replay so OSC 133 re-parses instead of duplicating.
- **Replay is silent** (`replaying`): drop attention signals until `term.write(buffer, cb)` calls
  back, else every remount re-raises old notifications and failed blocks.
- **Never fit a 0×0 host** (a parked host is 0×0) and never forward a 0×0 or unchanged size.
  Debounce resize (~90 ms + rAF); cancel the rAF on unmount.
- **Spawn the pty at the real fitted size**, never 80×24 (prompt "staircase"); `nextSizeAction()`
  decides attach/resize/noop, don't re-inline it. The real size is the settled one: one FitAddon
  pass is not a fixed point under the DOM renderer (cell width = `round(charWidth × cols) / cols`),
  so `safeFit` re-fits until stable (`settleFit`). The configured fonts load before the first
  render (`preloadFonts`) so the spawn measures the real glyphs; font changes go through
  `syncSize`, never a bare `pty.resize`. A pty resized while the shell starts leaves zsh's
  PROMPT_SP `%` on screen (`e2e/workspace-restore.spec.ts`).
- **Prompt-aware atomic resize** (`syncSize`/`flushHold`): at an idle prompt resize the pty only,
  hold bytes until the repaint idles (~24 ms, 150 ms cap), then in one batch erase from
  `min(prompt-marker row, cursor row)`, **restore the cursor where the shell left it**, regrid to
  the captured dims, write the repaint. Never erase without a repaint in hand (bash doesn't redraw
  on WINCH); don't re-fit at flush; take the prompt row from a marker; held bytes with OSC 133;C are
  output, written without erasing (`isPromptRepaint`). Guard: `e2e/resize-prompt.spec.ts`.
- **Selection must stand out from painted cells**: every xterm takes its theme through
  `terminalTheme` (`visibleSelection`), never a scheme's raw `colors`. Guard:
  `e2e/terminal-selection.spec.ts`.
- **xterm's viewport paints black**: `.xterm-host .xterm .xterm-viewport` stays transparent; the
  host paints the theme background.

**Input editor**
- **Suppression is keyed on the prompt's A marker** (`draft.promptLine`), never the draft object
  (zsh re-emits B on every redraw). Place the editor from xterm's cursor, never the B mark.
- **Its textarea text is transparent** under `.input-editor-highlight`: keep font, padding, border,
  line height (the cell height), letter spacing (the cell width), wrapping and scrollbar gutter
  identical, or caret and selection drift.
- **Its root is transparent**; only `.input-editor-line` and `.input-editor-chips` paint a
  background (a root background hid all output).

**Restore**
- **Two files, two processes** (`workspaceSnapshot.ts`): the renderer autosaves `workspaces.json`;
  main writes `scrollback.json` every 5 s and at `before-quit` (before the kill loop). Each write
  merges restored scrollback not yet replayed.
- **Persist the serialized screen, never raw pty bytes** (`screenMirror.ts`: `feedPty`, `resizePty`
  incl. the gateway path; `serialize()` cut before the idle prompt). Keep it width-independent
  (logical lines, spaces, SGR only, no cursor moves); never swap in `@xterm/addon-serialize`. The
  live ring stays raw.
- **Restored scrollback is one-shot** (`takeRestoredScrollback`): pushed through the `PtySession`
  ring and captured via `since(0)` before `addLiveSubscriber`, else it paints twice.
- **The restore seam leads with a bare OSC 133;D**, so a command running at quit doesn't return as a
  block that runs forever.
- **Settings load and `hydrate()` run before the first render** (`main.tsx`), else restored
  terminals start on defaults and an early pane spawns an orphaned pty.

**Renderer and React**
- **A throwing effect cleanup takes the whole window down** (React 18; v0.0.9 diff-tab crash). A
  cleanup must not touch an object another cleanup may have disposed: check it is still current
  (`diffRef.current === diff`). Guard: `e2e/crash-recovery.spec.ts`.
- **Portaled surfaces don't bubble React events to `Pane`**: activation uses native
  `mousedown`/`focusin` listeners on the frame.
- **Pane drops land on `.pane-drop-layer`, never the surface** (portals and `<webview>` swallow drag
  events); zones come from the frame's rect (`dropZoneAt`). Drag-out uses the drag's own coordinates
  (`endedOutside`), never `window.screenX`. Guard: `e2e/pane-dnd.spec.ts`.
- **Allotment is keyed by the child-id list** and reads `sizes` only at mount: a store size change
  needs a remount (new child list or bumped `equalized`). Always pass `defaultSizes`, one per child,
  else new splits flash at the left edge. Guard: `e2e/panel-open.spec.ts` (samples after each
  frame's last ResizeObserver callback).

**Browser, extensions and tools**
- **Never gate webview-guest instrumentation on `listenerCount`** (Electron always listens to
  `console-message`): instrument once at `did-attach-webview` (`instrumentedGuests`); check the
  debugger with `debugger.isAttached()`.
- **Dispose the server-side connection when an extension process exits** (`onExit`), else in-flight
  requests hang 30 s.
- **The CLI reads stdin only for extension commands with `stdin: true`**; agent harnesses leave
  stdin open.
- **pty children inherit Electron's fds**, listening sockets included: the ports extension drops
  every socket its parent also holds.
- **The user's CLIs have sharp edges** (`src/extensions/trellis`, `src/extensions/keeper`): trellis
  errors are JSON on **stderr**; `trellis version` appends a notice after its JSON (parse the first
  line); foreground `trellis ui` prints nothing (ask `trellis daemon status --json`); the session
  cookie is set only at `/` (deep links need the proxy); `events --consumer` advances only on
  `events ack` and a new consumer starts at 0 (prime it silently); an unknown project re-lists
  workspaces (`isOpenProject`, `UNKNOWN_PROJECT_RETRIES`) before dropping. `keeper approve`/`ui`
  auto-start the daemon: gate them with `keeper daemon status`. Keeper has no per-ticket route;
  notices open `/approvals`.

**E2E**
- **E2E reads terminal text from the DOM renderer**: `isolatedLaunch()` seeds
  `DOM_RENDERER_SETTINGS`; a spec seeding `settings.json` spreads it in. Only
  `terminal-webgl.spec.ts` and `terminal-selection.spec.ts` run WebGL.
- **E2E isolates every data dir** (`e2e/dataHome.ts` → `isolatedLaunch()`): `XDG_DATA_HOME`,
  `--user-data-dir` (a spec once rewrote the developer's `settings.json`), `XDG_CONFIG_HOME`, and a
  temp `HOME` with a plain prompt and a test git identity (`testHome`). Compare against
  `app.getPath('home')`, never the test process's `homedir()`.

---

## 7. Testing

Vitest 2 (unit + component) + Playwright (E2E). Config: `vitest.config.ts`, `vitest.workspace.ts`.
Which spec covers what: Trellis vault `architecture/testing/test-map`.

- **node** project: `src/main/**`, `src/shared/**`, `src/cli/**`, `src/extensions/**`. Its global
  setup (`test/buildOnce.ts`) builds the CLI and built-in extensions once per run; tests never
  rebuild them. At most 8 workers (`vitest.config.ts`).
- **dom** project (jsdom, `test/setup.ts`): `src/renderer/**`. The typed `window.pine` fake
  (`test/mocks/pine.ts`, typed as `PineBridge`) breaks when the contract drifts.
- **E2E** (`e2e/`): anything rendering xterm or Monaco, or needing a real pty, a restart, or a
  crash. The app boots with no workspaces: a spec that needs a terminal starts with
  `openWorkspace(win)` (`e2e/helpers.ts`). Every launch uses `isolatedLaunch()` (§6).

Rules:
- Reset state between tests: zustand stores are singletons; `setState(init, true)` in `afterEach`,
  reset id counters, reset every cross-referenced store.
- No stub tests. Every test asserts observable behavior tied to a requirement.
- A bug fix comes with a test that fails without the fix.
- Style model: `src/renderer/layout/tree.test.ts` (`describe(unit)`, `it('does X when Y')`).
- Never point a test at a real outside program or service: the user's CLIs (trellis, keeper) are
  fake scripts in `test/fixtures/tools/bin/` first on `PATH`, fed scrubbed captures from
  `test/fixtures/tools/<tool>/`; package managers and sudo are fakes in `test/fixtures/system/bin/`;
  AI providers are local fake servers; MCP servers are `test/fixtures/mcp/fake-server.mjs`; agents
  are `fakeAgentBin` / `test/fixtures/manager/bin/fake-agent`. Native dialogs are answered by
  stubbing `dialog.showMessageBox` via `app.evaluate`.
- Extension tests that need `src/main` live in `src/main` or `src/cli`, never under
  `src/extensions`. Extension host tests spawn fixtures (`test/fixtures/extensions/echo`,
  `extensions-assist/oracle`, `extensions-e2e/hello`) over a real socket.

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
  `PINE_TOKEN`, so `pine <agent>` from it opens the manager. The check stops a confused or injected
  agent, not a determined process running as the same user.
- **Sandboxes are not VMs.** bwrap/Seatbelt stop a misbehaving agent, not a kernel exploit. SBX-C58
  (macOS loopback-only binding) runs only on macOS.
- **Latent:** `pluginsStore.load()` isn't in-flight idempotent (two concurrent calls double-fetch).

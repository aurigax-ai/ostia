# CLAUDE.md — pine (Terminal Workspace)

Rules for any agent (or human) changing this repo. Read this before touching code. When you
change an invariant, command, or convention, update the matching section here in the same commit.

| Doc | Holds |
|---|---|
| `PRODUCT.md` | Who it's for, principles, and the **Goals** table (built / partial / not started) |
| `docs/ARCHITECTURE.md` | How it's built, module map, and every "Why:" behind non-obvious code |
| `docs/DESIGN.md` | Tokens, type scale, components, a11y rules |
| `docs/ROADMAP.md` | Lean-core architecture (core / built-in extensions / plugins) and phased plan |
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
- Generated shadcn files in `src/renderer/components/ui/**` are exempt; don't hand-edit them.
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
| `pnpm build` | Build `out/{main,preload,renderer}`, the `pine` CLI, and the built-in extensions (`out/extensions`) | Before `preview` / E2E |
| `pnpm build:extensions` | Only the built-in extensions (`scripts/build-extensions.mjs`) | After editing `src/extensions/**` while `pnpm dev` runs |
| `pnpm preview` | Run the built app | Smoke-test a build |
| `pnpm package` | `build` + electron-builder → `dist/linux-unpacked/` | Producing an installable build |
| `pnpm install:local` | `package` + `scripts/install-linux.sh` → `~/.local/share/pine/app` + desktop launcher | Updating the user's installed app |
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
- **extensions** (`src/extensions/`): built-in extensions (kanban, wiki) + their SDK. Each runs
  as its own process and talks to pine only over the control socket (`docs/EXTENSIONS.md`).
  The host that runs them is `src/main/extensionHost.ts`.

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
  capability, and paste via `term.paste`.
- **Never inject into the user's dotfiles.** zsh via a generated `ZDOTDIR` (+ `PINE_ZDOTDIR_ORIG`);
  bash via `--rcfile`. Generated files live in `privateTmpDir('pine-shell-integration')`:
  `<tmp>/pine-shell-integration-<uid>`, mode 0700, refused if it's a symlink or not ours.
- **Layout tree transforms are pure** (`src/renderer/layout/tree.ts`): no React, no store access.
  Transforms return the same object when nothing changed. `resetIds`/`adoptIds` are the only
  exceptions.
- **Ids minted from counters are adopted on restore** (`adoptIds`, `adoptSessionIds`). Skip it and a
  new pane reuses a restored pane's id, and two panes share one shell.
- **Nothing live is ever restored.** A restored session comes back idle with a fresh shell at its
  saved cwd; replayed scrollback is history. Same for `processManager` (running → exited at load;
  loaded entries can't be restarted).
- **Session/pane guards:** never zero sessions; `closePane` never removes the last pane and emits
  `pane-closed` only if the pane existed; a session's `workDir` is the anchor, a pane's `cwd` wanders.
- **App chords must not steal terminal keys.** Linux/Windows: `Ctrl+Shift+P` palette,
  `Ctrl+Shift+B` sidebar, `Ctrl+,` settings, `Ctrl+Shift+U` jump to latest unread,
  `Ctrl+Shift+H` command history, `Ctrl+Shift+C/V` copy/paste, `Ctrl+Shift+F` find,
  `Ctrl+Shift+↑/↓` previous/next block. macOS uses ⌘ (⌘⇧U unread, ⌘⇧H history, ⌘↑/⌘↓ blocks).
  Plain `Ctrl+<letter>` (incl. `Ctrl+R`), plain/Ctrl arrows and Escape belong to the shell;
  Escape is swallowed only while a block is selected. All chords live in `lib/chords.ts`;
  xterm's `attachCustomKeyEventHandler` lets app chords through. Block navigation is a terminal
  chord (handled in xterm), never a window chord, so inputs and Monaco keep Shift/⌘+arrow
  selection. Show hints via `chordLabel()`.
- **Capabilities:** acting on any target other than your own pane/window/session needs
  `workspace-wide`. Agents can't grant themselves caps: `settings set` refuses `capabilities.*`;
  grants come only from a human editing `settings.json`. Phone caps map through `PHONE_CAP_ALLOWS`;
  `input` must never map to a command capability. Phone grants (`command`, `input`,
  `board.write`, `destructive`) change only through the `gateway:set-cap` IPC from Settings →
  Remote; never add a control-socket method or CLI verb for them. `destructive` needs `command`
  and a confirm dialog.
- **Gateway:** off by default, loopback bind by default, never rotate the cert, reject requests
  with an `Origin` header, check `Host`, 1 MiB frame cap, 10 s hello deadline. Revocation closes
  live sockets AND re-checks the device on every request. Every frame uses the device's current
  caps from the store; removing a cap closes its live sockets (4004). Pty input and resize need
  an owner attachment plus `input`.
- **Attention goes through `reduceAttention`** (`lib/attention.ts`), dispatched via
  `attentionStore`/`signalPane`. Session state is derived from pane attention + running blocks by
  `startAttentionSync`; never `setState` a session's live state directly. A signal to the pane
  being viewed must apply `view` immediately (`signalPane` does), or it rings while you look at it.
- **Renderer attention commands act on the command target only** (`ctx.activePaneId`), never on
  a pane id in args: `command.exec` checks capabilities against the target, so an args pane id
  would bypass `workspace-wide`.
- **node-pty is loaded lazily and tolerated absent.**
- **What may live in core:** code that needs xterm or pty internals, or that every other feature
  depends on (windows, sessions, panes, pty + shell integration, blocks, restore, command
  registry/palette/chords, attention/notifications, settings, control socket + capabilities,
  extension host). Everything else is an extension (`docs/ROADMAP.md` §2). Don't add a new
  feature module to `src/main` or a feature view to `src/renderer`; write an extension, and if
  the extension API can't express it, extend the API rather than special-casing core.
- **Extensions use only the public API.** Code in `src/extensions/**` imports only
  `src/extensions/sdk/` and `src/shared/`, never `src/main` or `src/renderer`, and reaches pine
  only through `ext.*` socket methods. Core never imports extension code; it knows an extension
  by its manifest. (The gateway's `board.*` methods call the kanban extension's commands through
  `ExtensionHost.invoke`, the same path the CLI uses.)
- **Extension identities are not panes.** `controlServer` gates every method by caller kind
  (`callers`); new pane-scoped methods keep the default `panes`. An extension's caps are manifest
  ∩ human approval (`extensionStore.ts`), set with `setCaps` on each start.
- **Only the human approves or enables an extension** — the approval dialog or Settings, through
  `extensions:*` IPC. Never add a socket method or CLI verb that approves, enables, or changes an
  extension's caps.
- **Extension panels stay sandboxed.** Partition `pine-ext-<id>`, src and every navigation must
  pass `ExtensionHost.isAllowedPanelUrl` (a file inside the extension dir, or the loopback origin
  its process reported), no preload, permissions denied. A panel never gets `window.pine` or a
  token; it talks only to its own extension process.
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
- **Model:** a **Session** (sidebar; `kind`, `workDir`, live `state`) owns a split-tree of **Panes**;
  each pane hosts one **Surface**: `terminal | editor | browser | extension` (`agent` is
  reserved in the type and snapshot format, not yet created).
- **UI:** shadcn primitives (on Base UI, not Radix) from `components/ui/` for buttons, inputs,
  selects, dialogs, tooltips. Tokens and type scale in `docs/DESIGN.md`; never hardcode colors or
  off-scale font sizes. `--fg-dim` is never used for text. Icon-only buttons are `IconButton`.
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
  Covered by `e2e/resize-prompt.spec.ts` (split + drag-resize with output above the prompt).
- **Attention is silent during replay** (`Terminal.tsx` `replaying`): the attach replay buffer
  re-parses old OSC 9/777/99, BELs and failed OSC 133;D marks. Signals are dropped until
  `term.write(buffer, cb)` calls back, else every remount/restore re-raises old notifications.
- **Portaled surfaces don't bubble React events to their `Pane`.** SurfacePool portals each
  surface, so its React parent is SurfacePool. Pane activation uses native `mousedown`/`focusin`
  listeners on the frame; a React `onMouseDownCapture` there only saw header clicks.
- **OSC 7 is not percent-decoded**: hooks emit raw paths; decoding corrupts dirs like `100%20off`.
- **Session restore is two files from two processes** (`sessionSnapshot.ts`): the renderer
  autosaves `sessions.json` as you work; main writes `scrollback.json` every 5 s when output
  changed and again at `before-quit` (before the kill loop). Each write merges restored scrollback
  not yet replayed, else quitting before visiting a session erases its history.
- **Restored scrollback is one-shot** (`takeRestoredScrollback`): pane ids get re-issued. It's
  pushed through the `PtySession` ring (so remounts replay it) and captured via `since(0)` before
  `addLiveSubscriber` (else it paints twice).
- **The restore seam leads with a bare OSC 133;D** so a command running at quit doesn't come back
  as a block that runs forever.
- **`hydrate()` runs before the first render** (`main.tsx`): a pane mounted against the seeded
  layout would spawn a pty that's orphaned a tick later.
- **Allotment is keyed by the child-id list**; its internal sizes go stale on structural changes.
- **xterm's viewport paints black by default.** `.xterm-host .xterm .xterm-viewport` is
  transparent and the host is painted with the terminal theme background.
- **Dispose the server-side connection when an extension process exits** (`extensionHost.ts`
  `onExit`). vscode-jsonrpc doesn't reject in-flight requests when the socket closes, so an
  invoke that crashed the process would otherwise hang until the 30 s request timeout.
- **The CLI reads stdin only for extension commands whose manifest says `stdin: true`.** Agent
  harnesses often leave stdin open; reading it unconditionally hangs every `pine <ext> …` call.
- **E2E must isolate both data dirs** (`e2e/dataHome.ts` → `isolatedLaunch()`): a fresh
  `XDG_DATA_HOME` (else a spec restores the previous spec's panes) and `--user-data-dir` (else a
  spec rewrites the developer's real `settings.json`, which has happened). It also sets
  `XDG_CONFIG_HOME` so the developer's own user extensions (and their approval dialog) stay out.

---

## 7. Testing

Vitest 2 (unit + component) + Playwright (E2E). Config: `vitest.config.ts`, `vitest.workspace.ts`.

- **node** project: `src/main/**`, `src/shared/**`, `src/cli/**`, `src/extensions/**`. Extension
  host integration tests spawn `test/fixtures/extensions/echo` over a real socket;
  `src/cli/cli.ext.e2e.test.ts` builds and drives the real kanban/wiki extensions via the CLI.
- **dom** project (jsdom, `test/setup.ts`): `src/renderer/**`. A typed `window.pine` fake
  (`test/mocks/pine.ts`, typed as `PineBridge`) breaks when the contract drifts.
- **E2E** (`e2e/`): anything rendering xterm or Monaco, or needing a real pty, a restart, or a crash.

Rules:
- Reset state between tests: zustand stores are singletons; `setState(init, true)` in `afterEach`,
  reset id counters, reset every cross-referenced store.
- No stub tests. Every test asserts observable behavior tied to a requirement.
- A bug fix comes with a test that fails without the fix.
- Style model: `src/renderer/layout/tree.test.ts` (`describe(unit)`, `it('does X when Y')`).

---

## 8. Known gaps

- **Session restore is soft, not tmux.** Ptys are children of the Electron main process, so quit
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
- **Monaco theme is fixed** (one-dark-vivid) regardless of the app theme.
- **Latent:** `pluginsStore.load()` isn't in-flight idempotent (two concurrent calls double-fetch);
  `SettingsPanel` passes a ref to a non-forwardRef `Input`, so the search box isn't focused on open.

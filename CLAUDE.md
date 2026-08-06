# CLAUDE.md — pine (Terminal Workspace)

Guidance for any agent (or human) working in this repo. Read this before touching code.
Keep it current: when you change an invariant, command, or convention, update the matching
section here in the same commit.

---

## 1. What this is

`pine` is a cross-platform (Linux-first → macOS/Windows) **terminal-first workspace**: a Warp-like
terminal with command *blocks*, a VSCode-like file tree + Monaco editor, LSP, live git, managed
agent CLIs, and a control plane (CLI + local socket) for driving it. Electron + React + TypeScript.
Full design in `docs/ARCHITECTURE.md`, `docs/DESIGN.md`, `docs/DESIGN-GUIDELINES.md`.

> **`pine` is a codename constant** — the product name, CLI binary (`pine`), config dir
> (`~/.config/pine/`), `PINE_*` env vars, and `.pine-workspace` extension all rename from one
> place. Never hardcode the product name in a new subsystem.

---

## 2. Commands — and when to run each

**Package manager is `pnpm`.** (A `package-lock.json` also exists but pnpm + `pnpm-workspace.yaml`
is authoritative. Use `pnpm`.)

| Command | What it does | Run it when |
|---|---|---|
| `pnpm dev` | `electron-vite dev` — HMR renderer + main/preload reload | Daily development |
| `pnpm build` | Build `out/{main,preload,renderer}` **and** the `pine` CLI (esbuild) | Before `preview`/E2E, or to verify a prod build |
| `pnpm preview` / `pnpm start` | Run the built app (no dev server) | Smoke-test a build |
| `pnpm typecheck` | `tsc --noEmit` × 2 (renderer/shared, then main/preload/shared) | **Before every commit** — CI gate |
| `pnpm lint` / `pnpm format` | Biome check / auto-format (`src` only) | Before commit |
| `pnpm rebuild` | `electron-rebuild -f -w node-pty` | **After any Electron bump, fresh install, or Node/ABI change.** node-pty is a native addon; if not rebuilt for Electron's ABI, terminals silently disable (main logs `node-pty unavailable — run: npm run rebuild`) |
| `pnpm test` | Vitest unit + component (`node` + `dom` projects) | Before commit; while developing |
| `pnpm test:watch` | Vitest watch (node+dom) | Active TDD |
| `pnpm test:coverage` | Coverage report (v8) | To find gaps / measure a suite |
| `pnpm test:unit` | Only the `node` project (main + pure logic) | Fast main-process loop |
| `pnpm test:security` | The security regression project | Check the known fs gap (see §8) |
| `pnpm test:e2e` | Playwright against the **built** app | After `pnpm build` **and** `pnpm rebuild` |

---

## 3. Architecture — three processes + the bridge

- **main** (`src/main/`, Node, privileged, CommonJS): app/window lifecycle, node-pty session manager
  (`ptySession.ts`, `ptyRingBuffer.ts`), read-only FS IPC, LSP manager (`lsp.ts`), shell-integration
  injection (`shellIntegration.ts`), session restore (`sessionSnapshot.ts`), and the **control plane**
  (`controlServer.ts`, `controlAuth.ts`,
  `capabilityStore.ts`, `idRegistry.ts`) exposing commands over a local unix socket. `src/main/gateway/`
  (Phase C) re-exposes a subset of that control plane over the LAN as a self-signed-TLS `https`+`ws`
  server for the Pine Companion phone app (`gateway.*` control methods, elevated `gateway` cap) — **off
  by default**, never auto-started; see `pine-companion/NETWORK-CONTRACT.md`.
- **preload** (`src/preload/index.ts`): the **single** `contextBridge.exposeInMainWorld('pine', …)`
  surface. Thin, typed, forwards `ipcRenderer.invoke/send/on` only — **no logic**.
- **renderer** (`src/renderer/`, React 18 + TS, **no Node access**): xterm.js terminal, Monaco editor,
  zustand stores, cmdk palette, command registry + bridges.
- **shared** (`src/shared/types.ts`, `capabilities.ts`): dependency-free types + the IPC contract
  (`PineBridge`), imported by all three.
- **cli** (`src/cli/index.ts`): the `pine` CLI that talks to the control socket.

**Security baseline** (enforced in `baseWebPreferences()`, `src/main/index.ts`, for *every* window):
`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, preload set. External links are
denied in-window and shell-opened. The renderer reaches privileged ops **only** through `window.pine`.

---

## 4. Invariants you MUST NOT break

- **Renderer has zero Node access.** A new capability = add to `PineBridge` in `shared/types.ts` →
  handler in `src/main/` → thin forwarder in `src/preload/index.ts`. Keep preload logic-free.
- **The pty lives in MAIN, keyed by pane id**, and survives pane remounts (split/relocate/tear-off).
  `pty:attach` re-binds + replays a capped buffer; `pty:detach` keeps it alive for a grace window
  (`DETACH_GRACE_MS`) then reaps. Don't move pty ownership to the renderer or key it by anything but
  pane id; don't drop the detach grace or the replay buffer.
- **Shell-integration marks are the block/cwd source of truth.** Main injects OSC 133 (A/B/C/D) +
  OSC 7 at spawn (`shellIntegration.ts`); `Terminal.tsx` parses them. cwd flows OUT
  (terminal→pane→Files), never in. Only **zsh/bash** are integrated; fish/sh/pwsh spawn with NO
  integration but still work — degrade gracefully, never hard-fail on an unknown shell.
- **Never inject into the user's real dotfiles.** zsh via a generated `ZDOTDIR` (+ `PINE_ZDOTDIR_ORIG`
  restore); bash via `--rcfile`. Generated files live under `tmpdir()/pine-shell-integration`, source
  the real dotfiles, then restore env for nested shells.
- **Layout tree transforms are pure/immutable** (`src/renderer/layout/tree.ts`): no React, no store
  access. `layoutStore` calls them. Keep new pane ops as pure functions there. (`resetIds`/`adoptIds`
  are the two sanctioned exceptions — they move the module's id counter, nothing else.)
- **Ids minted from a counter must be ADOPTED on restore.** Pane/split ids (`layout/tree.ts`) and
  session ids (`sessionsStore`) come from counters that start at 0 in a fresh process, while a
  restored workspace carries ids from the previous run. `adoptIds`/`adoptSessionIds` advance the
  counters past them. Skip that and a new pane gets an id a restored pane already holds — and main
  keys ptys BY PANE ID, so the two panes would share one shell.
- **Nothing live is ever restored.** A restored session comes back `idle` with a brand-new shell at
  its saved cwd; replayed scrollback is history, not a reattached process. Same posture as
  `processManager.ts` (persists the process table, relabels `running` → `exited` at load). Don't add
  a restore path that implies a surviving process — that needs a pty-host daemon (see §9).
- **Session/pane guards:** never leave zero sessions (`closeSession` re-seeds home); `closePane`
  never removes the last pane; a session's `workDir` is the anchor, a pane's `cwd` may wander.
- **node-pty is loaded lazily and tolerated absent** — never assume it's present.

---

## 5. Conventions

- **Biome** (single tool: lint + format + import-organize): **2-space** indent, **single quotes**,
  **semicolons "asNeeded"** (i.e. none unless required), `lineWidth: 100`. `src/renderer/components/ui/**`
  has the linter disabled (generated shadcn/Base-UI — don't hand-lint or hand-test).
- **TypeScript strict** everywhere (+ `noUnusedLocals`/`noUnusedParameters`). Prefix intentionally
  unused params with `_` (`_e`, `_workerId`). Path aliases: `@/*` → `src/renderer/*`,
  `@shared/*` → `src/shared/*`.
- **High JSDoc density is house style.** Every exported type/function gets a `/** … */`; non-obvious
  decisions get a "why" comment (often citing `docs/ARCHITECTURE.md §`). Explain the *why*.
- **Naming:** components `PascalCase.tsx`; stores/libs `camelCase.ts`; stores are `useXStore`;
  generated shell symbols are `__pine_*`.
- **zustand:** `create<State>((set, get) => ({ … }))` with state + actions colocated. Immutable
  updates. Cross-store access via `useOtherStore.getState()`; subscribe inside React via a selector
  `useSettingsStore((s) => s.…)`. Pure logic stays OUT of the store (see `layout/tree.ts`).
- **Session → Panes → Surface model:** a **Session** (sidebar) has a `kind`, a `workDir` anchor, and a
  `state`; each session owns a **split-tree layout** of **Panes**; a Pane hosts one **Surface**
  (`terminal | editor | agent | browser`) with its own `cwd`. Split H/V, close, move (drop zones),
  tear-off into a window.

---

## 6. Dragons (gotchas proven by past bugs — don't "fix" naively)

- **`BASH_B_MARK` escaping** (`shellIntegration.ts`): the OSC 133;B mark is built with `String.raw`
  and interpolated as a *value*, single-quoted in the emitted rc. A double-quoted inline copy let
  bash collapse `\]`, leaking a `]` into the prompt. Don't rewrite it inline.
- **Bash preexec false-positives:** the DEBUG trap also fires for `PROMPT_COMMAND`'s own body —
  guarded by an `__pine_interactive_mode` gate and by running the user's original `PROMPT_COMMAND`
  from inside a function (not `;`-joined).
- **Pty buffer trim boundary** (`ptyRingBuffer.ts` / main): when trimming the replay buffer, advance
  the cut to just after the next `\n`, else the next `\x1b` — a raw slice can sever an OSC/CSI escape
  and corrupt xterm's parser on replay.
- **`pty:attach` race** (`Terminal.tsx`): subscribe to `onData` BEFORE `attach`, queue bytes, flush
  after the replay buffer is written; reset the pane before replay so OSC 133 re-parse rather than
  duplicate.
- **`safeFit` never on a 0×0 host** (`Terminal.tsx`): FitAddon on a 0-sized host computes 0 cols/rows
  and corrupts the pty buffer (the cmux "infinite duplication" bug). Never forward a 0×0 or unchanged
  size to `pty.resize`. Debounce resize (~90ms + rAF); cancel the rAF on unmount.
- **Spawn the pty at the REAL fitted size, never xterm's 80×24 default** (`Terminal.tsx` +
  `terminalSizing.ts`): `pty:attach` DEFERS until the portal slot has a layout box and `safeFit`
  actually fit (the ResizeObserver drives the first fit, un-debounced while unattached). Attaching
  at the 80×24 default and then growing draws the shell's first prompt + right-aligned RPROMPT
  narrow, and xterm's reflow strands/stacks them — the prompt "staircase" (races only when the slot
  is 0×0 on first paint). The attach-vs-resize-vs-noop decision is the pure `nextSizeAction()`
  (unit-tested); don't re-inline it or attach eagerly.
- **Prompt-aware ATOMIC resize** (`Terminal.tsx` `syncSize`/`flushHold`): the prompt line spans the
  full width (RPROMPT at the last column), so a narrowing reflow wraps the old prompt line into rows
  the shell's SIGWINCH redraw won't clear — duplicated prompts (e2e/resize-prompt.spec.ts). At an
  OSC 133 prompt (open draft, nothing running): resize the PTY ONLY (local grid untouched — user
  keeps seeing the intact old prompt), HOLD incoming pty bytes until the shell's repaint burst goes
  idle (~24ms gap, 150ms hard cap), then erase (CUP min(mark row, cursor row) + ED0) + regrid to the
  CAPTURED dims + write the held repaint as one batch → one rendered frame, no duplicate/blank flash.
  Two traps proven by earlier attempts: (a) never erase unless a repaint is actually in hand — a
  shell that doesn't redraw on WINCH (bash/readline) would be left with a vanished prompt (empty
  hold → plain reflow instead); (b) apply the captured dims, don't re-run fit-and-dedup at flush —
  it can decide "unchanged, skip" and desync. `syncSize` re-runs after flush to catch drag drift.
- **OSC 7 is NOT percent-decoded** — hooks emit raw paths; `decodeURIComponent` would corrupt dirs
  like `100%20off`.
- **Session restore is TWO files written by two processes** (`main/sessionSnapshot.ts`): the renderer
  autosaves `sessions.json` continuously (only it knows the layout tree), main dumps `scrollback.json`
  at `before-quit` (only it holds the pty rings) — and that dump MUST run before the kill loop, since
  `pty.kill()` drops the ring with the entry. Quit is far too late for a renderer round-trip, which is
  why the layout is kept fresh as you work rather than captured on exit.
- **Restored scrollback is one-shot** (`takeRestoredScrollback`): consumed by the first `pty:attach`
  for that pane id. Pane ids get re-issued, so a *new* pane reusing a restored id must not inherit the
  old shell's history. The restored bytes are pushed through the `PtySession` ring (not sent straight
  to the subscriber) so a later remount replays them too — and captured via `since(0)` BEFORE
  `addLiveSubscriber`, else they'd paint twice.
- **The restore seam leads with a bare OSC 133;D** (`RESTORE_SEAM`, `main/index.ts`): a command still
  running at quit would otherwise come back as a block that runs forever. `blocksStore.commandEnd`
  no-ops when nothing is running, so the mark is safe when there's nothing to close.
- **E2E must isolate BOTH data dirs** (`e2e/dataHome.ts` → `isolatedLaunch()`): restore makes every run
  reopen the previous one's workspace, so without a throwaway `XDG_DATA_HOME` a spec restores the
  previous spec's panes (breaking pane counts). And a spec that flips a setting needs
  `--user-data-dir` too, or it rewrites the DEVELOPER's real `settings.json` — that actually happened
  while building this: a test turned `restoreSession` off globally and every later launch silently
  stopped persisting.
- **Tear-off trusts the OS cursor** (`screen.getCursorScreenPoint()`), not flaky drag-event coords.

---

## 7. Testing

**Stack:** Vitest 2 (unit + component) + Playwright (E2E). Config: `vitest.config.ts` (base: aliases +
v8 coverage) and `vitest.workspace.ts` (three projects). See
`docs/superpowers/specs/2026-07-03-test-infrastructure-design.md` for the full design.

- **`node` project** (env: node) — `src/main/**`, `src/shared/**`: main-process + framework-free logic.
- **`dom` project** (env: jsdom, `test/setup.ts`) — `src/renderer/**`: stores + components. A typed
  `window.pine` fake is installed per-test (`test/mocks/pine.ts`, typed as `PineBridge` so it breaks
  when the contract drifts). `@testing-library/react` + jest-dom matchers; trees unmount between tests.
- **`security` project** — `test/security/**`: the RED fs-traversal regression suite, **excluded** from
  `pnpm test` (run via `pnpm test:security`).

**Where does a new test go?**
- Pure logic / parsers / main-process → **node** project, co-located `*.test.ts`.
- Stores + React components → **dom** project, co-located `*.test.{ts,tsx}`.
- Anything that renders **xterm** or **Monaco**, or streams a **real pty** → **Playwright E2E**
  (`e2e/`), against the built app. These don't work under jsdom (canvas/workers/layout) — mock them at
  unit level and assert *wiring* (attach called, resize forwarded, disposed on unmount).

**Rules of the house:**
- **Reset state between tests.** zustand stores are module singletons — capture pristine state once
  and `setState(init, true)` (replace, not merge) in `afterEach`; reset id counters (`tree` exports
  `resetIds()`). Reset **every** cross-referenced store (sessions↔layout↔settings).
- **No stub/empty tests.** Every test asserts real, observable behavior tied to a requirement. Use
  `pnpm test:coverage` to find gaps — but coverage is a floor, not the goal; a high-% test that
  asserts nothing is worse than none. (Watch function-coverage vs statement-coverage: handlers that
  are defined but never invoked show up as low function coverage.)
- **The style model** is `src/renderer/layout/tree.test.ts`: `import { describe, it, expect } from
  'vitest'`, `describe(unitUnderTest)`, `it('does X when Y')`.

---

## 8. Known gaps & latent bugs

- **fs path-traversal — FIXED.** `fs:read` / `fs:write` / `fs:list` now route user paths through
  `resolveSafe()` (**`src/main/pathGuard.ts`**, boundary-correct incl. sibling-prefix), confining
  access to `[homedir(), userData]`. Reads/writes/lists outside home (e.g. `/etc/passwd`) or `../`
  escapes return the normal empty/null/false error result. The terminal (node-pty) is unaffected —
  it still runs anywhere; only the explorer/editor file access is contained. To browse outside home,
  broaden `allowedRoots` in `registerFsIpc` (`main/index.ts`). Proof: `src/main/pathGuard.test.ts`
  (unit) + `e2e/security.spec.ts` (end-to-end, real app).
- **Session restore is "soft", not tmux.** Ptys are children of the Electron main process, so quitting
  still kills every shell — what survives is the workspace's *shape* plus each pane's scrollback
  (`sessionSnapshot.ts`, `stores/persistence.ts`, `e2e/session-restore.spec.ts`; docs/ARCHITECTURE.md
  §5.12). **True reattach** — live processes surviving a quit — needs a separate long-lived pty-host
  daemon that main connects to over a socket; `PtySession`'s owner/observer + `since(cursor)` model is
  already the right seam for it, but nothing else is built. Don't describe the current feature as
  "resume like tmux" to a user; it reopens where you were, it doesn't keep your process running.
- **Latent bugs (harmless today; documented for whoever owns the source):**
  - `layout/tree.ts` `setPaneEditor`: cwd = `path.slice(0, path.lastIndexOf('/')) || '/'` returns a
    truncated string (`'notes.tx'` for `'notes.txt'`) when the path has no `/`. Fine today — `openFile`
    only passes absolute paths.
  - `stores/layoutStore.ts` `closePane`: the emit guard `removed = findPane(root, paneId) === null` is
    true both when a pane was actually removed AND when the id never existed, so a double-close (or a
    bogus id) emits a spurious `pane-closed`. Fix: `removed = existedBefore && !existsAfter`.
  - `stores/pluginsStore.ts` `load()`: not in-flight idempotent — two concurrent calls both pass the
    `if (loaded) return` guard before either awaits, double-fetching. Very low impact (load runs once).
  - `components/SettingsPanel.tsx`: a React "function components cannot be given refs" warning — a ref
    passed to a non-forwardRef child silently no-ops.

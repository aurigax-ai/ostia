# Terminal Workspace — Stack & Architecture

> A cross-platform (Linux-first → macOS/Windows) terminal-first workspace: a Warp-like
> terminal with command blocks, a VSCode-like file tree + code viewer, live git status,
> managed agent CLIs (Claude Code et al.), and a first-class plugin system.
> The "ultimate CLI workspace."
>
> **Working codename:** `pine` (Terminal Workspace) — provisional, centralized in one constant so the
> product name, CLI binary (`pine`), config dir (`~/.config/pine/`), `PINE_*` env vars, and `.pine-workspace`
> extension all rename together. **MVP target:** end of Milestone **M1** (§6) — a usable terminal
> workspace you can run agents in.

---

## 1. Goals

| # | Goal | What it means in practice |
|---|------|----------------------------|
| 1 | **Terminal-first** | A fast, GPU-rendered terminal is the centerpiece, with Warp-style command *blocks*. |
| 2 | **VSCode-like shell** | Resizable left file tree + main area (terminal / editor) + panels + status bar. |
| 3 | **IDE-grade editor** | Full Monaco editor: LSP (IntelliSense, diagnostics, go-to-def, rename), TextMate grammars, themes, diff view. |
| 4 | **Live git** | Status decorations in the tree, a source-control panel, diffs, branch indicator. |
| 5 | **Agent integration** | Launch & manage Claude Code + other agent CLIs as first-class citizens — incl. parallel isolated git-worktree sessions (cmux-style). |
| 6 | **Plugin system** | Sandboxed, permissioned extensions contributing commands, panels, themes, agents. |
| 7 | **Cross-platform** | Linux first; macOS + Windows after the core stabilizes. |
| 8 | **Flexible workspaces** | Single-dir focus, multi-root across dirs, or an ad-hoc "kitchen-sink" session — all first-class. |
| 9 | **Arrangeable panes** | VSCode-style docking + tmux/cmux-style splits; any pane holds a terminal, editor, or panel. |
| 10 | **Programmable control** | Every action is a named command — driveable from the palette, a **control CLI**, and **agent skills** that act on the current pane/workspace. |
| 11 | **Durable sessions** | Resume the exact window/layout/work-dirs and recent work; archive + auto-archive sessions without losing them. |
| 12 | **Companion control** | A phone app (remote client of the command layer) to monitor agents, approve/intervene, and drive the workspace away from the desk. |
| 13 | **Appearance & i18n** | Per-surface theme + font (UI · terminal · editor, JetBrains-style); English + Traditional Chinese with CJK-safe fonts. *(First-class from day one — see DESIGN.md.)* |

---

## 2. Final tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Desktop shell** | **Electron** | Consistent Chromium webview on every OS; the most battle-tested path for a terminal app. |
| **Language** | **TypeScript** everywhere | Type-safe IPC contracts across main/renderer/plugins. |
| **Frontend** | **React + TypeScript** | Best component ecosystem for VSCode-like UI; fast enough (Electron + terminal dominate cost). |
| **Build/dev** | **electron-vite** (Vite) | Fast HMR, TS-first, clean main/preload/renderer split. |
| **Terminal renderer** | **@xterm/xterm** + WebGL/fit/search/web-links/unicode11 addons | What VSCode uses; GPU-accelerated. |
| **PTY backend** | **node-pty** (Node native addon) | Idiomatic for Electron; supports zsh/fish/bash perfectly. Rust hot-paths added later via napi-rs. |
| **Shell integration** | OSC 133 + zsh `precmd`/`preexec`, bash DEBUG trap, fish events | Powers command blocks, cwd tracking, exit codes. |
| **Code editor** | **Monaco** (the VSCode editor) | Full IDE editing — IntelliSense UI, multi-cursor, minimap, folding, built-in diff editor. Bundle weight is a non-issue in a desktop app. |
| **LSP client** | **monaco-languageclient** + vscode-jsonrpc | Bridges Monaco to real language servers (rust-analyzer, tsserver, pyright, gopls, clangd…). |
| **Syntax grammars** | **vscode-textmate** + **vscode-oniguruma** (WASM) | Reuse VSCode's TextMate grammar + theme ecosystem for accurate highlighting. |
| **Theming** | Design tokens (CSS vars) + VSCode theme JSON | One theme drives app chrome, Monaco, and the terminal. |
| **File tree** | **react-arborist** | Virtualized, keyboard-navigable, drag/drop. |
| **Split rendering** | **allotment** | Nested, resizable VSCode-style splits (extracted from VSCode). |
| **Layout model** | Recursive split-tree in zustand | tmux/cmux-style splittable panes; any pane = terminal / editor / panel; drag-to-dock, zoom, persist. |
| **Workspace model** | Multi-root workspace files (`.terminal-workspace`) | Single-dir, multi-root, or kitchen-sink; per-root git/LSP/cwd scoping. |
| **Control surface** | Command registry + local socket + `pine` CLI | Palette, keybindings, CLI, and agent skills all invoke the same typed commands. |
| **Control gateway** | WebSocket/JSON-RPC bridge + QR pairing | Authenticated network access to the same commands; powers the phone companion. LAN-first, optional relay. |
| **Companion app** | Expo / React Native (shared TS command contract) | Phone remote: monitor agents, approve prompts, run commands/skills. PWA as a lighter MVP. |
| **Command palette** | **cmdk** | Warp/VSCode-style `Ctrl+K` palette. |
| **State** | **zustand** | Light, no boilerplate. |
| **Git** | **simple-git** (spawns system `git`) | Full-featured, fast, uses installed git 2.54. |
| **FS watching** | **chokidar** | Reliable cross-platform file watching. |
| **Lint/format** | **Biome** | Single fast tool for lint + format. |
| **Tests** | **Vitest** + Playwright (e2e later) | Fast unit tests; e2e for the Electron shell. |
| **Packaging** | **electron-builder** | AppImage/deb/rpm (Linux) → dmg/nsis (mac/win). |
| **Future native** | **napi-rs (Rust)** | Drop-in Rust modules for search/indexing/large diffs when needed. |

### Why xterm.js and not Ghostty / a native engine?
"TTY" spans three layers: the **PTY** (OS pseudo-terminal → node-pty), the **terminal emulator**
(parses output, draws the grid → xterm.js), and the **terminal app** (this product). **Ghostty is a
complete *native* terminal app** — it renders to its own GPU surface (Metal/OpenGL/Vulkan) and
**cannot composite into Chromium's web view**. `libghostty` (the embeddable library) isn't a stable
public API yet and wouldn't render into a web UI regardless. Embedding a native engine like Ghostty or
`alacritty_terminal` means **abandoning Electron + React and rebuilding the whole VSCode-like UI
natively** — a far larger project. xterm.js (what VSCode's integrated terminal uses) + WebGL is the
pragmatic fit for this stack. Native engines win on input latency / peak throughput; if that ever
becomes a hard requirement, the decision to revisit is **Electron itself**, not "Ghostty inside Electron."

### Why not Rust PTY directly?
A PTY library is **shell-agnostic** — it allocates a pseudo-terminal and execs the shell binary, so
`zsh`/`fish`/`bash` behave identically under `node-pty` or Rust's `portable-pty`. Pairing a *Rust* PTY
with Electron needs a sidecar process or napi-rs addon for **no real gain** (the OS pseudo-terminal is
the heavy part, not the binding). So: **node-pty now**, Rust via napi-rs later for genuinely hot paths.

---

## 3. Process & security model

Electron multi-process, with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.

```
┌─────────────────────────────────────────────────────────────────┐
│ MAIN process (Node, privileged)                                   │
│  • app/window lifecycle                                           │
│  • PTY session manager (node-pty)                                 │
│  • filesystem + chokidar watcher                                  │
│  • git service (simple-git)                                       │
│  • agent CLI manager                                              │
│  • plugin host supervisor                                         │
│  • typed IPC handlers                                             │
└───────────────▲───────────────────────────────▲──────────────────┘
                │ typed IPC (ipcMain)            │ RPC
                │ + MessagePort (PTY byte stream)│
┌───────────────┴────────────────┐   ┌───────────┴──────────────────┐
│ PRELOAD (contextBridge)        │   │ PLUGIN HOST (utilityProcess)  │
│  • minimal typed API surface   │   │  • sandboxed, permissioned    │
└───────────────▲────────────────┘   │  • runs 3rd-party plugin code │
                │                     └───────────────────────────────┘
┌───────────────┴────────────────────────────────────────────────────┐
│ RENDERER process (React + TS, no Node access)                       │
│  Terminal (xterm.js) · FileTree · Editor (Monaco) · GitPanel ·      │
│  CommandPalette · StatusBar · plugin UI surfaces (iframes)          │
└─────────────────────────────────────────────────────────────────────┘
```

- **All privileged work lives in main.** Renderer talks only through the typed preload bridge.
- **PTY bytes stream over a `MessagePort`** (not JSON-over-IPC) for throughput, with flow control
  (pause/resume) so a noisy command can't overwhelm the renderer.
- **Plugins never run in the renderer or main directly** — they run in a sandboxed `utilityProcess`
  and reach fs/git/shell only through brokered, permissioned APIs.

### 3.1 Permission broker (one capability model for everything untrusted)
Three subsystems run or accept untrusted/least-privileged callers — **plugins** (§5.7), **agent
commands** (§5.11), and the **phone companion** (§5.13). They all funnel through a single
**permission broker** in main:

- Every privileged op (fs read/write, network, shell/PTY, git, agent control, destructive commands) is a
  **capability**. Callers hold a **capability set**; the broker checks it on every command.
- **Plugins** declare needed capabilities in their manifest (granted on install); **agents** get a scoped
  set per session; the **companion** gets a subset, with destructive commands requiring confirmation.
- One audited choke point — easier to reason about than per-feature checks, and the place to add
  prompts, rate limits, and an audit log later.

---

## 4. Folder structure

```
terminal/
├─ package.json
├─ electron.vite.config.ts
├─ tsconfig.json
├─ biome.json
├─ src/
│  ├─ main/                  # Electron main (Node, privileged)
│  │  ├─ index.ts
│  │  ├─ pty/                # node-pty session manager + MessagePort streaming
│  │  ├─ fs/                 # filesystem ops + chokidar watcher
│  │  ├─ git/                # simple-git service (status/diff/branch/log)
│  │  ├─ lsp/                # LSP server manager (spawn/route language servers)
│  │  ├─ workspace/          # workspace files: roots, per-root scoping, load/save
│  │  ├─ agents/             # agent CLI registry + process manager
│  │  ├─ gateway/            # network bridge: QR pairing/auth, remote command access, push
│  │  ├─ plugins/            # plugin host supervisor + permission broker
│  │  └─ ipc/                # typed IPC channel handlers
│  ├─ preload/
│  │  └─ index.ts            # contextBridge: typed, minimal API
│  ├─ renderer/             # React + TS UI
│  │  ├─ App.tsx
│  │  ├─ components/
│  │  │  ├─ Terminal/        # xterm.js wrapper, blocks UI
│  │  │  ├─ FileTree/        # react-arborist + git decorations
│  │  │  ├─ Editor/          # Monaco + monaco-languageclient + diff editor
│  │  │  ├─ GitPanel/        # source control view + diffs
│  │  │  ├─ CommandPalette/  # cmdk
│  │  │  ├─ StatusBar/       # branch, cwd, agent status
│  │  │  └─ Layout/          # pane/split-tree manager, drag-to-dock, pane tabs
│  │  ├─ panels/             # dockable panels: Problems, Output, Outline, Agent logs
│  │  ├─ stores/             # zustand: layout (split-tree), workspace, theme, sessions
│  │  └─ theme/              # token engine + VSCode-theme loader (app + Monaco + xterm)
│  ├─ shared/               # types + IPC contracts (imported by all 3)
│  └─ shell-integration/    # zsh/bash/fish hook scripts (OSC 133 + cwd)
├─ plugins/                  # bundled / example plugins
├─ companion/                # phone app (Expo/RN) — remote client of the control layer
├─ resources/                # icons, etc.
└─ docs/
   └─ ARCHITECTURE.md
```

### 4.1 Runtime storage layout (XDG)
The repo above is source; user data lives outside it, under standard base dirs (keyed off the `pine`
codename — one constant renames all of them):

- `~/.config/pine/` — settings, keybindings, themes, plugin registry.
- `~/.local/share/pine/` — durable data: `sessions/`, `workspaces/`, `scratch/<date>-<name>/`,
  `archive/`, `worktrees/`, and per-agent session dirs.
- `~/.cache/pine/` — caches (grammar/oniguruma WASM, search indexes); safe to delete.
- Control socket: `$XDG_RUNTIME_DIR/pine.sock` (per session).

---

## 5. Key subsystems

### 5.1 Terminal core
- One `node-pty` per session in main; bytes streamed to renderer via `MessagePort`.
- xterm.js with `@xterm/addon-webgl` (GPU), `addon-fit`, `addon-search`, `addon-web-links`,
  `addon-unicode11`.
- Tabs + splits (managed in renderer layout via `allotment`); each split = one PTY session.
- Flow control + resize round-tripped to the PTY.

### 5.2 Shell integration → command "blocks" (the Warp feel)
- On session start, source a shell-integration script for the detected shell:
  - **zsh**: `precmd` / `preexec` hooks emit OSC 133 (prompt/command start, command end + exit code).
  - **bash**: `PROMPT_COMMAND` + `DEBUG` trap.
  - **fish**: `fish_prompt` + `fish_preexec`/`fish_postexec` events.
  - **cwd**: OSC 7 on each prompt.
- xterm.js parses these markers → delineates blocks (one command + its output), tracks cwd and exit
  status. Enables: collapse/expand, copy block output, re-run, jump between blocks, status coloring.

### 5.3 File tree
- `react-arborist` (virtualized) fed by main-process directory reads (lazy-loaded children).
- `chokidar` watches the workspace; deltas pushed to renderer to keep the tree live.
- `.gitignore`-aware; git status decorations overlaid (see 5.5).

### 5.4 Editor / IDE
**Monaco** (the VSCode editor core) is the editing surface — full IDE behavior, not a viewer.

- **Editing**: multi-cursor, minimap, folding, bracket matching, find/replace-in-file, dirty-state
  tracking, editor tabs + split editors.
- **Syntax & color schemes**: highlighting via **vscode-textmate** + **vscode-oniguruma** (WASM
  Oniguruma regex) using real VSCode `.tmLanguage` grammars; colors from VSCode theme files (see §5.8).
- **Diff editor**: Monaco's built-in side-by-side diff — reused directly for git diffs (§5.5).
- **Language Server Protocol (LSP)** via `monaco-languageclient`:
  - **Server manager (main process)**: a registry mapping language → server command
    (`rust-analyzer`, `typescript-language-server`, `pyright`, `gopls`, `clangd`, …). Detects installed
    servers, spawns one per language/workspace root, supervises lifecycle, routes by document.
  - **Transport**: language client runs in the renderer; JSON-RPC is proxied through main (which owns
    the child process) over IPC using `vscode-jsonrpc` readers/writers.
  - **Features surfaced**: completion/IntelliSense, hover, signature help, diagnostics → **Problems
    panel**, go-to-definition / references / implementation, rename, code actions / quick fixes,
    formatting, document symbols → **Outline** + breadcrumbs.
- **Future**: Debug Adapter Protocol (DAP) for breakpoint debugging — same external-process pattern as
  LSP, added as its own phase.

### 5.5 Git
- `simple-git` in main: `status`, `diff`, `branch`, `log`, stage/unstage, commit.
- Tree decorations (modified/added/untracked), a source-control panel (staged/unstaged + inline diff),
  branch + ahead/behind in the status bar.
- Watch `.git/` to refresh on external changes.

### 5.6 Agent / harness manager
- A registry of agent CLIs (Claude Code, others) with launch configs (cmd, args, cwd, env).
- Two integration modes:
  1. **Terminal-attached** — run the agent in a dedicated terminal pane with full shell integration.
  2. **Structured adapter** — talk to an agent's stdio/JSON protocol for richer UI (status, steps, logs).
- An "Agents" panel: see running agents, status, logs; start/stop/switch; per-project presets.
- **Isolated worktree sessions (cmux-style)** — the primitive for parallel agents:
  - Launching an agent can create a **git worktree** on a new branch off a chosen trunk, so N agents
    run **in parallel without interfering**; a broken run never touches your main tree.
  - Each session has a deterministic id (`${project}-${branch}`) + its own session dir holding the
    agent's chat history and config (model, tool policies); close/discard it independently.
  - **Status board** (agents report branch/test/build/progress to a sidebar) and **cross-agent
    messaging** (inject instructions from one agent pane into another) are exposed as commands in the
    control layer (§5.11) — à la cmux `set-progress` / `cmux send`.
  - Worktrees are created/cleaned via the git service (§5.5); sessions map onto panes (§5.10).

### 5.7 Plugin system
- **Manifest** (`plugin.json`) declares contributions + requested **permissions**:
  - `commands` (palette + keybindings), `panels` (UI surfaces), `themes`,
    `terminalAddons`, `agentAdapters`, `gitProviders`, `statusBarItems`.
  - permissions: `fs`, `network`, `shell`, `git`, `agent` (granted explicitly).
- **Plugin host**: sandboxed `utilityProcess`; plugins get a typed API namespace (à la VSCode's
  `vscode`) and reach privileged ops only through the **permission broker** in main.
- **UI contributions**: rendered in isolated iframes/webviews with a constrained bridge — a misbehaving
  plugin can't crash or block the app.
- **Distribution**: local folders first; a registry later.

### 5.8 Theming system
**One theme, three render targets.** A theme is consumed once and projected onto every surface:

- **App chrome** (tree, tabs, panels, status bar, splits) — driven by **CSS-variable design tokens**.
- **Editor** — Monaco theme derived from VSCode theme JSON (`tokenColors` + `colors`).
- **Terminal** — xterm.js theme object (16 ANSI colors + fg/bg/cursor/selection).
- **Source of truth**: import real **VSCode theme files** (huge existing ecosystem); a loader maps them
  to all three targets so importing one theme restyles the whole app coherently.
- Light/dark/high-contrast + user-authored + **plugin-contributed** themes; switch at runtime; respect
  OS light/dark preference.

### 5.9 Workspace model (single-dir · multi-root · kitchen-sink)
A **Workspace** is an ordered set of **roots** (folders). The three modes you described are just
different root counts of the *same* model:

| Mode | Roots | Use |
|------|-------|-----|
| **Focus** | exactly 1 | Work on one project (`open ~/proj`). Simplest, default. |
| **Multi-root** | N | Work across several dirs at once (à la VSCode multi-root workspaces). |
| **Kitchen-sink** | 0 or `$HOME` | Ad-hoc/scratch session: arbitrary terminals + open any file, no project binding. Organized as **scratch items** — see §5.14. |

- **Per-root scoping** — each root carries its own: file-tree subtree, **git** repo binding, **LSP**
  server set (TS server for root A, rust-analyzer for root B), and default terminal **cwd**. Search can
  be scoped to one root or fanned across all.
- **Serializable** — a `.terminal-workspace` file stores roots + layout + open editors/terminals +
  setting overrides (like VSCode's `.code-workspace`). Recent-workspaces list; quick switcher in the
  palette; add/remove a root live.
- **Promotion** — a kitchen-sink session can be saved into a named workspace at any time.
- **Window ↔ workspace** — one window hosts one workspace (multiple windows for multiple workspaces);
  workspace *tabs* within a window are a possible later addition.

> **Two senses of "workspace."** This §5.9 model is the *view* workspace (roots + layout, à la
> VSCode / **Warp** Launch Configs). It is distinct from a cmux-style **agent worktree session**
> (an isolated worktree + branch + history for one agent, §5.6). They're orthogonal — one view
> workspace can host many agent worktree sessions.

### 5.10 Layout & panes (VSCode docking + tmux/cmux splits)
The layout is a **recursive split-tree**: internal nodes are splits (horizontal/vertical + child sizes),
leaves are **panes**. **Any pane can host any view** — a terminal, an editor, or a panel (Problems,
Outline, Agent logs) — so terminals and editors tile together freely. This is the
"VSCode + Warp + tmux" combination.

- **Rendering**: `allotment` (nested resizable splits); the split-tree *model* lives in a zustand store.
- **Pane ops**: split H/V, close, swap/move, resize, **focus next/prev** (keyboard, tmux- or
  VSCode-group-style), **zoom/maximize** a pane (tmux `prefix z`), **drag a tab to an edge → new split**
  (VSCode docking).
- **Tabs per pane**: a pane has its own tab strip (several terminals/editors in one pane — like VSCode
  editor groups or tmux windows).
- **Default arrangement** (sidebar tree + editor area + bottom panel) is just a *preset* of the general
  split-tree, so power users can rearrange everything. **Named layout presets** ("coding",
  "terminal-heavy") are saved as portable **YAML/TOML** files — like **Warp's Launch Configs / Tab
  Configs** — defining windows/tabs/panes with per-pane `cwd`, title, and startup commands; restored
  per workspace.
- **App-native splits are primary** — you don't need tmux for tiling — but tmux still runs fine inside
  any pane. **Detachable/floating panes** (pop a pane into its own OS window) are a later addition.

### 5.11 Command & control layer (CLI + agent skills)
**Everything the app can do is a named command** — one registry, many callers. This is what makes the
workspace programmable and lets agents build *skills* that act on the live UI (the cmux
`cmux send` / `set-progress` idea, generalized).

- **Command registry** — every action is a typed command with a JSON-schema'd payload:
  `pane.split`, `pane.focus`, `pane.zoom`, `editor.open`, `terminal.run`, `workspace.addRoot`,
  `agent.send`, `status.setProgress`, `git.stage`, … One source of truth.
- **Callers (all hit the same registry):**
  1. **Command palette** (cmdk) — interactive.
  2. **Keybindings** — bound to commands.
  3. **Control CLI** — a small `pine` binary that forwards `pine <command> [args]` to the running app over
     a **local control socket** (Unix domain socket / named pipe). Like `code .`, `tmux send-keys`,
     `cmux send`.
  4. **Agents → skills** — an agent running inside a pane calls the same `pine` CLI; a *skill* is just a
     documented recipe of these commands.
  5. **Plugins** — register new commands and invoke existing ones (§5.7).
- **Context-aware targeting** — a process launched in a pane gets env (`PINE_SOCKET`, `PINE_PANE_ID`,
  `PINE_WORKSPACE`) so commands resolve "**current** pane/editor/workspace" automatically. An agent in
  pane X runs `pine split` → splits *its own* pane; `pine open foo.rs` → opens in the current group;
  `pine status "running tests"` → writes to *its* status slot.
- **Introspection for agents** — `pine commands --json` emits every command + arg schema, so an agent can
  discover capabilities and author skills against them. (Doubles as the contract for plugin authors.)
- **Safety** — the control socket is per-session and scoped; agent/plugin commands honor the permission
  broker (§5.7); destructive commands are gated.

### 5.12 Session persistence, resume & archiving
The workspace is **durable** — close it and reopen exactly where you left off, and keep old sessions
around without clutter.

> **Status: soft resume SHIPPED; archiving still planned.** Implemented today: the layout split-tree,
> per-pane surface + cwd, and per-pane terminal scrollback survive a quit, and the app reopens them at
> launch with FRESH shells. `main/sessionSnapshot.ts` (durable + validation), `renderer/layout/
> snapshot.ts` (translation), `renderer/stores/persistence.ts` (debounced autosave), `session.save`
> (control layer), `behavior.restoreSession` (settings, default on). Proven end-to-end by
> `e2e/session-restore.spec.ts`. NOT yet implemented from this section: window geometry, editor
> cursor/scroll/unsaved buffers, startup-command replay, recents, archive/auto-archive, worktree
> hygiene, and true reattach.

- **Session snapshot (per workspace)** — window geometry, the **layout split-tree** (panes + sizes),
  each pane's view (terminal cwd + startup command + saved scrollback/blocks, or editor file + cursor +
  scroll + cached unsaved buffer), the **roots/work dirs**, open tabs, active pane, and agent sessions.
- **Autosave + resume** — snapshot is autosaved (debounced) and on quit; on launch the app **reopens
  the last session**, or you pick one from the switcher. Stored in the data dir
  (`~/.local/share/pine/`, §4.1) as `sessions.json` (the workspace, written by the renderer as you
  work) + `scrollback.json` (per-pane pty tail, dumped by main at `before-quit`). Two files, not one,
  because only the renderer knows the layout and only main holds the pty rings — and quit is far too
  late to ask the renderer for anything. Both are re-validated on read (`parseSnapshot`): they are
  hand-editable, and a corrupt one must degrade to "no restore", never to a broken window.
- **Resume fidelity** (terminals):
  - *Soft resume (default)* — reopen each pane at its **cwd**, optionally re-run its startup command,
    and restore saved scrollback/blocks (read-only history).
  - *True reattach* — keep the live process running across restarts; needs a persistent PTY backend
    (tmux-style daemon) — a later, optional upgrade.
  - Editors restore exactly; **agent worktree sessions** (§5.6) restore from their on-disk session dir.
- **Recent-work tracking** — a recency index (recent workspaces, files, dirs, commands) powers a
  "Recents" view and "resume what I was working on."
- **Archive** — move a workspace/session out of the active list into an **archive store** while keeping
  its full snapshot, so it can be **restored intact** later (close-but-keep). Browsable/searchable by
  name, repo, branch, last-active, files touched.
- **Auto-archive** — policy-driven (a main-process background job): archive sessions untouched for
  N days, or LRU-evict when the active count exceeds a threshold. Keeps the switcher clean, loses
  nothing.
- **Worktree hygiene** — auto-archiving an agent session can optionally **prune its git worktree**
  (keep / prune / prune-only-if-merged); restoring from archive **recreates the worktree** from the
  saved branch. Reclaims disk as cmux-style worktrees accumulate.
- All of the above are exposed as commands (`session.save`, `session.restore`, `session.archive`,
  `session.autoArchive`) in the control layer (§5.11), so they're scriptable and agent-drivable.
  `session.save` (flush the snapshot now) ships today. There is deliberately **no** runtime
  `session.restore`: re-hydrating a live window would have to tear down every attached pty
  mid-flight. Restore happens at boot, the one moment the workspace is empty enough for it to be safe.

### 5.13 Companion phone app (remote control)
Because **everything is already a command over a socket (§5.11)**, remote control is nearly free — the
phone is *just another client* of the same typed command registry, over a network transport instead of
the local socket. No second API to build.

- **Control gateway (main process)** — an optional, authenticated **WebSocket/JSON-RPC bridge** over the
  command registry. LAN-first (mDNS discovery); optional E2E-encrypted relay for off-network access.
- **Pairing & security** — pair by **QR code** (desktop shows it, phone scans) → shared key; per-device
  tokens, revocable; the phone gets a **capability subset** (permission broker, §5.7), and destructive
  commands require explicit confirmation. Controlling a computer from a phone is the highest-stakes
  surface in the app — gated and opt-in.
- **Phone use cases** (all just command calls / status streams):
  - **Monitor** — live status board: agent progress, test/build status, which agents are running.
  - **Approve / intervene** — answer agent approval prompts, `agent.send` instructions, pause/stop.
  - **Drive** — open files, run saved commands/**skills**, switch workspaces, apply layouts.
  - **Notify** — push notifications when an agent finishes, needs input, or a build fails.
  - **Terminal mirror** (later tier) — stream a pane's output to the phone with optional input.
- **App tech** — **Expo / React Native** so it shares the desktop's TypeScript **command contract**
  (`pine commands --json`), keeping one source of truth for actions; a **PWA** is the lighter MVP.
- The desktop stays the source of truth; the phone is a presence-aware remote.

### 5.14 Scratch / kitchen-sink workspace (incubator + one-offs)
The kitchen-sink (§5.9, zero project roots) is **not** an undifferentiated dump — it's a *managed*
scratch space with just enough structure to stay tidy. It serves two lifecycles:

**A. Incubator → graduate** (the brainstorm-then-build flow)
1. Open a kitchen-sink session; brainstorm/plan with Claude in an agent pane (history saved, §5.6).
2. When the idea sets, run **`workspace.promote`** ("Create project from this"): the app scaffolds a real
   project — new directory + `git init` + a fresh **project workspace** (§5.9) — and **starts Claude
   Code there primed with the brainstorm context** (the plan transcript is written into the project as
   `PLAN.md` / seeded as initial context). Clean handoff: loose thinking → a real project where work
   continues cleanly.
3. The scratch item is marked *graduated* (archived per §5.12, with a pointer to the new project).

**B. One-off / disposable** (e.g. video or image convert, a quick script)
- Each one-off is a **scratch item** in a **managed scratch dir**
  (`~/.local/share/pine/scratch/<date>-<name>/`, §4.1), so input/output files never pollute random folders.
- **Templates / skills** make these one-click — "Convert video", "Convert image", "Quick script" set up
  a scratch item with the right tool ready (an `ffmpeg`/`imagemagick` skill, §5.11) — no remembering
  flags. Grab the result, done.
- **Ephemeral by default** — auto-archived/auto-deleted after N days of inactivity (§5.12 policy).

**Organizing it**
- **Scratch items** — every ad-hoc task is a small **named, typed** (brainstorm / convert / script /
  note), **dated** container with its own panes/terminals/agent history — not one big pile. Shown as
  tabs in the kitchen-sink window and listed in a **Scratch dashboard**.
- **Disposition per item** — *ephemeral* (auto-clean), *promote* (→ project), or *keep* (save notes into
  the knowledge store). Auto-detect "this is becoming a project" (a repo / many files appear) → suggest
  promoting.
- **Auto-tidy** — auto-name items (date + topic inferred from the first prompt/command), auto-namespace
  scratch dirs, auto-archive ephemerals. Search/filter the dashboard by tag, type, age, recency (§5.12).
- All exposed as commands (`scratch.new`, `scratch.fromTemplate`, `workspace.promote`,
  `scratch.archive`) so the flow is palette-, CLI-, and agent-drivable (§5.11).

---

## 6. Phased roadmap

Grouped into milestones; each is independently demoable and **MVP = end of M1**. Two foundations are
pulled early on purpose: the **command registry** (the backbone every later caller rides on) lands in
**P0**, and **git core** lands in **M1** (workspaces, agents, and tree decorations all need it) — its
UI comes later.

### M0 — Skeleton
| Phase | Deliverable |
|-------|-------------|
| **0. Scaffold** | electron-vite + React + TS; window; **design-token baseline**; **minimal command registry** (typed action spine) wired to a few commands; minimal split-tree layout (split/close/resize, one pane); Biome + Vitest; `git init`. |

### M1 — Terminal workspace · ★ MVP
| Phase | Deliverable |
|-------|-------------|
| **1. Terminal core** | xterm.js + node-pty; zsh session; WebGL; split/tab any pane into terminals (`pane.split`, `terminal.new`). *Running Claude Code / any agent CLI in a pane works here already.* |
| **2. Shell integration** | OSC 133 blocks; cwd + exit-code tracking; blocks UI. |
| **3. File tree** | react-arborist + chokidar; open files into panes (single-root for now). |
| **4. Git core** | git service (status / branch / **worktree** ops) + tree decorations + branch in status bar. *Available early for workspaces & agents.* |

> **★ MVP / v0.1** — a real daily driver: tabbed/split terminals with command blocks, a live file tree,
> git status, and you can already run agents in panes. Everything past here is leverage.

### M2 — IDE
| Phase | Deliverable |
|-------|-------------|
| **5. Editor (Monaco)** | TextMate grammars; editor tabs; multi-cursor/minimap/folding; diff editor; dirty state. |
| **6. LSP** | server manager + monaco-languageclient; completion/hover/diagnostics, go-to-def/refs, rename; Problems + Outline. |
| **7. Git UI** | source-control panel; Monaco diffs; stage/unstage/commit; ahead/behind. |
| **8. Theming** | unified engine (app tokens + Monaco + xterm); import VSCode themes; light/dark/custom; OS preference. |

### M3 — Programmable + Agents *(the differentiators)*
| Phase | Deliverable |
|-------|-------------|
| **9. Command system & palette** | expand the registry; cmdk palette; keybindings; settings store. |
| **10. Control CLI & agent skills** | control socket + `pine` CLI; context-aware "current pane/workspace"; `pine commands --json` introspection; skill packaging. |
| **11. Workspace model** | single / multi-root / kitchen-sink; `.pine-workspace` files; switcher; per-root git/LSP/cwd; **scratch items + `workspace.promote`**. |
| **12. Session persistence** | snapshot/restore window + layout + roots + open editors/terminals; recents; archive + auto-archive. |
| **13. Layout & docking** | advanced split-tree ops: drag-to-dock, zoom, focus nav; named presets. |
| **14. Agent manager** | Agents panel; **cmux-style worktree sessions** (branch per agent, isolated history); status board + cross-agent send — on the command layer + git core. |

### M4 — Ecosystem + Mobile
| Phase | Deliverable |
|-------|-------------|
| **15. Plugin system** | manifest; sandboxed host; typed API (registers/calls commands); permission broker; example plugin. |
| **16. Companion phone app** | control gateway (QR pairing, auth, push) + Expo/RN client: monitor agents, approve/intervene, drive. |
| **17. Package & polish** | AppImage/deb/rpm; perf pass. Then macOS/Windows. |

**Future** — DAP debugging; multi-file search (ripgrep / napi-rs Rust); detachable/floating panes;
workspace tabs; terminal mirror to phone.

---

## 7. Open decisions (revisit later, not blocking)
- **PTY backend evolution**: stay on node-pty, or introduce Rust (napi-rs) for search/indexing? *(Default: node-pty now, Rust later only where measured.)*
- **Editor**: **Monaco chosen** for full IDE + LSP. CodeMirror 6 kept as a "go lighter" fallback if bundle size ever bites.
- **LSP transport**: language client in renderer with JSON-RPC proxied through main *(default)*, vs. running the client in main. Revisit if latency shows.
- **Panels**: model the bottom/side panels as nodes in the general split-tree *(default — most flexible)* vs. a fixed VSCode-like dock.
- **Workspace ↔ window**: one workspace per window *(default)* vs. workspace tabs within a window.
- **tmux interop**: app-native splits are primary; tmux still runs inside a pane. Control-mode integration is out of scope for now.
- **Agent isolation**: cmux-style git-worktree session per agent (parallel, isolated) *(default for multi-agent)* vs. agents in-place on the current tree.
- **Control transport**: Unix-domain socket + `pine` CLI *(default)*; optionally also a JSON-RPC/WebSocket endpoint for richer agent/plugin clients.
- **Companion app tech**: Expo/React Native (shares the TS command contract) *(default)* vs. a PWA MVP.
- **Companion remote access**: LAN-only via mDNS *(default — simplest/safest)* vs. opt-in E2E-encrypted relay for off-network control.
- **Session store**: flat JSON snapshots *(simple, start here)* vs. SQLite when history/blocks/sessions grow large.
- **Terminal resume fidelity**: re-run startup commands + restore scrollback/blocks *(default)* vs. true live-process reattach (needs a tmux-style persistent backend; later).
- **Scratch storage & disposition**: managed scratch dir (`~/.local/share/pine/scratch/...`, §4.1), ephemeral-by-default with auto-clean *(default)* vs. keep-until-explicit.
- **Debugging**: add DAP (Debug Adapter Protocol) as a future phase, mirroring the LSP server-manager pattern.
- **Plugin UI**: iframe/webview panels vs. a declarative component schema. *(Default: iframe for isolation.)*
- **Settings/state persistence**: flat JSON vs. SQLite for history/blocks at scale.
- **Build tooling**: **electron-vite (dev/build) + electron-builder (package)** *(chosen)* over Electron Forge — best HMR now + best Linux packaging (AppImage/deb/rpm) later; Forge's integrated publish isn't needed until M4.
- **Styling**: **Tailwind CSS v4** with `@theme` tokens *(chosen)* — utility-first chrome; the design tokens *are* the Tailwind theme.
- **i18n**: typed in-house catalogs (`useDict`, dependency-free) *(chosen)* vs. i18next if needs grow. Locales **en (default) + zh-Hant**, variant-aware (`en-GB`→`en`, `zh-TW`→`zh-Hant`).
- **CJK fonts**: system CJK fallbacks now; **bundle a dual-width mono** (Sarasa / Noto Sans Mono CJK) as the default terminal font so columns align with `@xterm/addon-unicode11`.
- **Appearance scope**: UI / terminal / editor themed + fonted independently but coordinated (JetBrains model). UI applies live now; terminal/editor apply when those surfaces ship.

---

## 8. Non-goals (scope discipline)
- **Not a full VSCode replacement** — Monaco gives IDE-grade editing, but we won't reimplement its
  entire extension API or settings surface.
- **Not a native terminal engine** — xterm.js is the renderer; native-engine perf is out of scope
  unless latency proves a hard blocker (§2).
- **No built-in cloud sync / accounts** initially — local-first; the companion is LAN/relay, not a
  hosted service.
- **Windows/macOS are second** — Linux-first; we won't gate M0–M3 on them.
- **Not an agent runtime** — we *orchestrate* agent CLIs (Claude Code et al.); we don't build our own.

## 9. Risks & mitigations
| Risk | Mitigation |
|------|-----------|
| **Native modules (node-pty) vs Electron ABI** — rebuild pain across versions. | Pin Electron; `@electron/rebuild` in postinstall; CI the rebuild. |
| **MessagePort PTY transfer** under `sandbox:true` + `contextIsolation` is fiddly. | `MessageChannelMain` main→renderer; spike in P1; fall back to throttled IPC if needed. |
| **monaco-languageclient** integration is non-trivial (workers, JSON-RPC over IPC). | Treat P6 as a focused spike; start with one server (tsserver), generalize once the pattern holds. |
| **Many LSP servers across multi-root** = heavy RAM. | Lazy-spawn per language *touched*; idle-timeout unused servers. |
| **Plugin sandbox escape / supply chain.** | utilityProcess isolation + permission broker (§3.1) + iframe UI; review/registry later. |
| **Control socket & companion = remote-code-exec surface.** | Per-session socket, capability scoping, QR pairing, confirm destructive ops, opt-in remote (§3.1, §5.13). |
| **Scope (17 phases, likely solo).** | Milestones + a hard MVP line at M1; everything after ships independently — cut/defer freely. |

## 10. Next step
**Phase 0** — scaffold the running skeleton: electron-vite + React + TS window, the design-token
baseline, a minimal command registry (the action spine), and the split-tree layout engine
(split/close/resize). Then **Phase 1** drops a live zsh terminal into a pane.

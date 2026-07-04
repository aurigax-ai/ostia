# Pine Agent Toolbelt — Master Plan (10 capabilities)

> **Core idea (user):** an agent (Claude Code / Gemini / Codex) drives Pine through **a skill** (which *teaches* the agent how) + **the `pine` CLI** (which *does* the control). This lets multiple agents coordinate *through* Pine. Persistence is **JSON** (agent-friendly) unless a better format is warranted. Settings too must be JSON + agent-controllable.

Built on the shipped A-MVP control plane (per-pane token auth, capability broker, `command.exec`/`command.list`, `pine` CLI). Everything below adds **main-side service modules** + **CLI verbs** + (where useful) **UI**, all cap-gated.

## Shared foundations (build FIRST — batch 1)
- **F1 — control-server method dispatch:** extend `controlServer.ts` so main-side services register socket methods (namespaced, e.g. `process.run`, `vault.set`), dispatched + cap-gated in main, alongside the existing renderer `command.exec`. A tiny `registerControlMethod(name, cap, handler)` registry.
- **F2 — JSON store helper (`src/main/store/jsonStore.ts`):** typed load/save/watch for JSON docs, with **project vs global** resolution: project = `<workDir>/.pine/<name>.json`; global = `~/.local/share/pine/<name>.json`. Atomic writes, debounce, tolerate missing/corrupt.
- **F3 — CLI subcommand router:** `pine <group> <sub> [args...]` maps groups (notify/open/process/vault/wiki/kanban/bus/settings/docs) to socket methods; keep `pine <command-id>` for raw UI commands. `--json`, stdin support (for no-echo secrets).

## The 10 capabilities

### 1. `pine notify` — notifications (batch 1 + batch 7)
- CLI `pine notify "<title>" ["<body>"]` → main fires an **Electron `Notification`** (OS notification center) + appends to a JSON notifications log (`global` + project) + emits an in-app event (renderer toast). When the **phone gateway (Phase C)** is connected, also push as an `agent.needs-input`/`notify` event (per the companion contract).
- Persist notifications as JSON so agents can read history (`pine notify --list`).

### 2. `pine open <file>` — open a file via CLI (batch 1)
- CLI `pine open <path>` → `command.exec('editor.open', {path})` (renderer `layoutStore.openFile` already exists) targeting the caller's session. Also `pine open --dir <path>` to reveal in the file browser. Resolve relative to the caller's `PINE_WORKSPACE`/cwd.

### 3. Task / process management (batch 2)
- Main **`processManager.ts`**: `run({cmd, cwd?, name?, env?})` spawns a tracked child (via `node-pty` or `child_process`), captures stdout/stderr into a ring buffer; `list()`, `info(id)`, `output(id, sinceCursor?)` (read output, cursor-based), `kill(id, signal?)`, `restart(id)`. Persist the task table (id, cmd, cwd, status, pid, startedAt) as JSON so it survives/inspects. Agents: "start the dev server", "read its output", "kill it".
- CLI: `pine process run "npm run dev" --name dev`, `pine process ls`, `pine process logs dev [--follow]`, `pine process kill dev`. Cap: `process` (elevated).
- UI (later): a "Processes" panel.

### 4. `pine docs` / help (batch 1)
- CLI `pine docs [group]` / `pine help` → returns human + machine docs for the CLI + commands (`command.list` already gives schemas; docs adds prose + examples). `pine commands --json` stays the machine contract. This is what the **skill (#5)** points agents at.

### 5. Skill — teach a code agent to use Pine (batch 8, after commands exist)
- A Claude Code skill (`.claude/skills/pine/SKILL.md` in-repo + installable) that teaches: what `pine` is, the verbs, capabilities/elevation, how to run/inspect processes, use the wiki/kanban/vault/bus, and multi-agent coordination recipes. Kept in sync with the CLI; `pine docs` is its runtime reference.

### 6. Wiki — project + global knowledge (batch 4)
- **`wiki.ts`** + JSON store: pages keyed by slug, with `get/set/list/search/delete`, at **project** (`.pine/wiki/`) and **global** (`~/.local/share/pine/wiki/`) scope. Inspired by memwiki / Karpathy's wiki: agents read/write operational knowledge; the **UI shows the wiki** (a panel/surface). Markdown body + JSON index (agent-friendly). CLI `pine wiki get <slug>`, `pine wiki set <slug> [--global]` (body via stdin), `pine wiki search <q>`. Cap: `wiki.read`/`wiki.write`.

### 7. Cross-agent bus — via CLI (batch 5, Phase B)
- The bus from the agent-platform spec (SQLite or JSON: mailbox + handoff), **exposed through the CLI**: `pine bus send <toPane> "<msg>"`, `pine bus inbox [--drain]`, `pine bus handoff ...`, `pine bus wait`. Cross-pane send needs elevation. Also an MCP surface (later). Lets agents in different panes message + hand off work.

### 8. Agent browser — IN-APP browser surface (revised per user: render in-app, not detached)
**Requirement:** the browser opens and renders **inside a Pine pane** (a new `browser` surface kind, alongside terminal/editor), NOT a detached window or a remote screencast. Fully agent-drivable.

**Why not Vercel's remote browser here:** Vercel's agent browser drives a *headless/remote/cloud* Chromium — its rendering is elsewhere, which contradicts "render in the app." **Electron already embeds Chromium**, so an in-app browser is native, local, and fully controllable. We **borrow Vercel's agent-facing command vocabulary** (a proven interface) but implement it against Electron's own `WebContents`. (A remote/headless "browse" backend could be an optional later mode; the primary is in-app.)

**Design (deep):**
- **New `browser` SurfaceKind.** Rendering options — spike both, pick one:
  - **`<webview>` tag** — embeds a guest `WebContents` in the renderer DOM → fits `SurfacePool`'s mount-once **portal** model directly (like terminal/editor). Fastest path to true in-DOM in-pane rendering; `<webview>` is legacy-but-supported.
  - **`WebContentsView`** (modern, replaces `BrowserView`) — a native view layered over the window at the pane's bounds; more robust/isolated, but NOT in the DOM, so it needs **bounds-sync** to the pane's slot rect (VSCode-webview style) instead of the portal. More work, more future-proof.
  - Recommendation: prototype `<webview>` first (fits the existing surface model); fall back to `WebContentsView` if `<webview>` limitations bite.
- **Isolation/security (critical — arbitrary web content):** the browser guest runs in its **own `partition`, `sandbox:true`, `nodeIntegration:false`, `contextIsolation:true`**, fully isolated from Pine's UI + main. Block `window.open`→detached (route to a new in-app browser pane instead). Per-pane session/partition so cookies don't leak across browser panes unless intended.
- **Agent automation via CDP (the Vercel-style verbs, implemented on `webContents`):** `pine browse open <url>`, `nav <back|forward|reload>`, `read [selector]` (visible text / accessibility tree — good for agents), `click <selector>`, `type <selector> <text>`, `eval <js>` (in the guest, sandboxed), `wait <selector>`, `screenshot [path]`, `content` (DOM/AX snapshot). Implemented in main via the guest `webContents` (`executeJavaScript`, `sendInputEvent`, and `webContents.debugger`/CDP `Page`/`DOM`/`Input`/`Accessibility` domains). Routed: `pine browse ...` → control socket → main → the target browser pane's `webContents`. The agent can *also* create the pane: `pine browse open <url>` with no browser pane → `command.exec('pane.split')` + set kind `browser`. Cap: `browse` (elevated).
- **UI:** the browser pane gets a minimal chrome (URL bar, back/forward/reload) for the human; the agent and human share the same live page. An "agent is driving" indicator when automated.
- **Scope:** this is a **real feature build** (new surface kind + guest-WebContents plumbing + CDP automation + minimal chrome), promoted from a research spike. Sequenced later (batch 9) as it's the largest single item; do a rendering spike (`<webview>` vs `WebContentsView`) first.

### 9. Kanban — via CLI for agent planning (batch 5, Phase B)
- JSON board (project `.pine/board.json`, git-friendly projection per the spec) + `kanban.ts`: columns/cards, `add/move/list/assign/done`. **CLI `pine kanban add "<task>"`, `pine kanban ls`, `pine kanban move <id> <col>`** so agents plan work. UI board panel. Cap: `board.read`/`board.write`. Shared datastore with the bus handoff rows (spec: "every handoff is a row").

### 10. Key vault — agent secret storage (batch 3)
- **`vault.ts`**: store secrets with **project + global** isolation. **No-echo:** `pine vault set <KEY>` reads the value from **stdin** (not argv) so it never appears in shell history/echo; `pine vault get <KEY>` prints to stdout only on explicit request (or injects into a process env for #3 without printing). `pine vault ls` lists keys (never values). Encrypt at rest (Electron `safeStorage` / OS keychain, else a key-derived AES). Cap: `vault.read`/`vault.write` (elevated). Agents store API keys etc. without leaking them into transcripts.

### Cross-cutting — settings as JSON + agent control
- Settings already live in `settings.json`. Add `pine settings get [key]` / `pine settings set <key> <value>` (validated against the existing JSON Schema) so agents can read/adjust configuration. Cap: `settings.write` (elevated).

## Build order (batches; sonnet subagents, orchestrated; mostly sequential to avoid shared-file conflicts)
1. **F1+F2+F3 foundations + #2 open + #4 docs + #1 notify (OS+log).**
2. **#3 process/task manager.**
3. **#10 key vault.**
4. **#6 wiki (+ UI panel).**
5. **#9 kanban + #7 cross-agent bus (shared datastore) (+ UI).**
6. **settings-as-JSON control + #1 phone-forward hook + notifications JSON.**
7. **#5 skill (documents the now-existing verbs).**
8. **#8 agent-browser research spike.**
9. **Phase C gateway** (implements `pine-companion/NETWORK-CONTRACT.md`).

Persistence = JSON throughout (vault encrypted). Each batch: new main service module + CLI verbs + cap-gating; UI where noted; commit per batch; merge to `main` locally as batches land (push later). Testing/bug-fixing is the parallel agent's lane — keep new logic in focused modules so it's test-friendly.

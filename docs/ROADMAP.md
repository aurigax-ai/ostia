# Roadmap: lean core, rich features

How pine gets Warp/cmux-level features without the core turning into an IDE. Goals and their
status live in `PRODUCT.md`; this file is the plan for closing the gaps.

## 1. Where the code is today

Non-test lines, 2026-09-28:

| Area | Lines | What it is |
|---|---|---|
| Terminal core (main): pty, shell integration, restore, fs, LSP spawn, control socket, capabilities | ~2,100 | Core |
| Browser automation (`main/browse.ts`) | ~1,800 | Feature |
| Gateway (`main/gateway/`) | ~1,100 | Feature |
| Kanban, wiki, vault, bus, processes (main) | ~1,150 | Features |
| CLI (`src/cli`) | ~1,900 | Mostly verbs for the features above |
| Renderer components | ~3,200 | Core shell + feature views |

About two thirds of main is features compiled into the core. Before phase 3 the plugin system
could only contribute data (themes, locales, language-server specs), not behavior or UI.

**After phase 3** (extension API v1, kanban + wiki migrated), counted over `src/{main,renderer,cli,shared,preload}`
without tests or generated `components/ui`:

| | Before | After |
|---|---|---|
| Core, all processes | 16,763 | 17,401 |
| Main process | 6,443 | 7,078 |
| Kanban/wiki code in core (main modules, two views, CLI verbs, IPC types) | ~1,360 | 0 |
| Extension host in core (`extensionHost/Manifest/Store.ts`, `shared/extensions.ts`) | 0 | ~1,070 |
| Extension UI in core (panel surface, approval dialog, Settings list, sidebar items, command bridge) | 0 | ~560 |
| `src/extensions/` (SDK + kanban + wiki, outside core) | 0 | ~1,350 TS |

Core lost the kanban/wiki code and both views, but the host and its UI cost more than the two
features did, so core is ~640 lines larger overall. That's the one-time price of the API; each
further feature that moves out (vault, bus, processes, browser automation, gateway) is now a pure
reduction.

## 2. Architecture: three rings

```
┌──────────────────────────── external plugins (Trellis, Keeper, yours) ───────────────┐
│ ┌──────────────────────── built-in extensions (ship in the box, can be disabled) ───┐ │
│ │ browser + automation · editor/LSP · files · git/diff · kanban · wiki · vault ·    │ │
│ │ bus · processes · gateway/remote                                                  │ │
│ │ ┌──────────────────────────── core ───────────────────────────────────────────┐   │ │
│ │ │ windows · sessions · split panes · pty + shell integration · blocks ·       │   │ │
│ │ │ restore · command registry + palette + chords · attention/notifications ·   │   │ │
│ │ │ settings · control socket + capabilities · extension host                  │   │ │
│ │ └─────────────────────────────────────────────────────────────────────────────┘   │ │
│ └───────────────────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

**Rule for what goes in core:** it needs xterm or pty internals, or every other feature depends on
it. Everything else is an extension, and built-ins use the same API as third-party plugins. If the
API can't express a built-in, fix the API rather than reaching into core.

### Extension API (the key decision)

**Chosen: out-of-process extensions over the existing control socket.**

- An extension is a manifest (`pine.json`: id, name, version, capabilities, contributions) plus an
  optional process that pine starts and talks JSON-RPC to over the same socket the `pine` CLI uses.
- It registers **commands** (palette + CLI), subscribes to **events** (pane created/closed, command
  started/finished, cwd changed, notification), and contributes **UI through fixed slots**:
  - sidebar status items per session (text + icon + tone, e.g. git branch, ports);
  - pane badges and attention state;
  - a **panel surface**: the extension serves a local HTML page, rendered in a sandboxed webview
    pane, which calls back over a scoped token.
- The capability model already exists; an extension gets exactly the caps its manifest declares
  and the user approves.

Why this over VS Code-style in-process JS extensions: the renderer stays sandboxed, a crashing
extension can't take the app down, extensions can be written in any language (Trellis and Keeper
are already CLIs), and agents and extensions share one API, so every extension feature is
automatically scriptable by agents. It's also how cmux's socket API and kitty's kittens work.
The cost is latency on UI-heavy features, which the panel surface avoids by running its UI in the
webview instead of round-tripping every render.

**First proof (done):** kanban and wiki moved out of core onto this API with no special case in
core. Their data logic runs in their own processes, their UI is a panel served by that process,
and `pine kanban …` / `pine wiki …` still work because the CLI forwards any unknown bare verb to
the extension of that id. Gaps the migration exposed, fixed in the API: commands needed a caller
context (session workDir, caller caps) so project-scoped data and conditional permission rules
could live in the extension; commands needed a `stdin` flag and `usage` text so CLI verbs keep
their shape and show up in `pine docs`; panels needed live change push (the SDK's SSE) and the
app theme (`--pine-*` variables). The phone gateway's `board.*` methods now call the kanban
extension through the host like any other consumer. Authoring guide: `docs/EXTENSIONS.md`.

## 3. Features from Warp and cmux, placed

| Feature | From | Ring | Size | Goal |
|---|---|---|---|---|
| Attention model: OSC 9/99/777, `pine notify`/`pine state`, pane rings, sidebar unread badges, jump to latest unread | cmux | core (built) | S–M | 1, 9 |
| Agent hooks recipe: Claude Code `Notification`/`Stop` hooks call `pine state waiting/done` | cmux | extension (docs + skill, built) | S | 1, 9 |
| Notification center (the bell, backed by the real notify log) | cmux | core (built) | S | 9 |
| Block actions: click to select, copy command/output, jump between blocks, sticky command header | Warp | core (built) | M | 7 |
| Command history search across panes | Warp | core (built) | M | 7 |
| Saved workflows / parameterized commands | Warp | extension | M | 7 |
| Git branch + dirty state in sidebar; listening ports | cmux | built-in extension | M | 3 |
| Diff view (Monaco diff editor) + "open in VS Code / Zed at file:line" | Warp/VS Code | built-in extension | M | 3, 6 |
| Pick element in browser → send selector, screenshot, console errors to an agent pane | new | with browser automation (built) | M | 3 |
| Your real Chrome: document Chrome DevTools MCP for agents instead of re-implementing CDP | new | docs (built) | S | 3 |
| Agent resume on restore (relaunch the agent CLI with its session id) | cmux | built-in extension | M | 5 |
| Trellis board panel, Keeper approvals panel | yours | built-in extensions (built) | M each | 4 |
| Settings sync (a synced folder you own) | Warp | core (built): it rewrites extension approvals | S–M | 8 |
| Phone: grant path above read-only, pty input, attention push | cmux-like | built-in extension (gateway) | M | 10 |
| Warp's IDE-style input editor | Warp | **not planned** | L | Clashes with agent TUIs that own the input line |
| Built-in AI chat | Warp | **not planned** | — | Pine hosts agent CLIs; it doesn't compete with them |

## 4. Phases

Each phase ships a working product; nothing half-built lands on `main`.

1. **Attention** (core, small) — **done**: the attention model (`lib/attention.ts`), OSC 9/99/777
   + BEL + `pine state`/`pine notify` sources, pane rings, sidebar unread badges, jump-to-unread
   (Ctrl+Shift+U / ⌘⇧U), the notification center, and the hooks recipe (`docs/AGENT-HOOKS.md`).
2. **Blocks** (core) — **done**: gutter-click block selection with a frame, Ctrl+Shift+↑/↓
   (⌘↑/⌘↓) navigation, context menu + palette actions (copy command/output/both, rerun at an
   idle prompt), sticky command header, and command history search across panes
   (Ctrl+Shift+H / ⌘⇧H).
3. **Extension API v1** — **done**: `pine.json` manifest, discovery (built-in + `~/.config/pine/extensions`),
   per-extension identity with manifest ∩ approved caps and a first-run approval dialog, lazy
   start with restart backoff, `ext.registerCommands/subscribe/setSidebarItem/notify/openPanel`,
   `pine ext …` and `pine <extId> …`, the sandboxed panel surface, and enable/disable in
   Settings → Plugins. Kanban and wiki migrated. Deferred: pane badges/attention from
   extensions, hot reload of the extension list, extension settings, and letting extensions call
   pane-scoped methods (browse, process) with an explicit target.
4. **Git & diff** as the first new built-in extension: sidebar branch/dirty, diff view, open in
   external editor.
5. **Browser → agent** — **done**: "Point at element" in browser panes (hover overlay in an
   isolated world, click to capture selector, html, box, style subset, a11y role/name, console
   errors, failed requests, element screenshot), a send panel that writes a markdown report,
   posts a bus message and pastes `@<report>` at the target pane's idle prompt, `pine browse pick`
   for agents to ask the human to click something, and `docs/CHROME.md` for pairing agents with
   the user's real Chrome through Chrome DevTools MCP. It lives next to `browse.ts` in core
   because the extension API can't yet drive pane-scoped browse methods (phase 3 deferral); it
   moves out with browser automation.
6. **Your tools** — **done**: built-in `trellis` and `keeper` extensions on the public API only
   (panels, per-session and global sidebar items, notifications that open the panel, palette
   commands), and settings sync through a user-chosen folder (Settings → Sync). API added for
   them, generic for any extension: `ext.confirm` (a human confirm dialog), `ext.notify
   {openPanel}` (a notification whose click opens your panel), the `shield` icon, and SDK helpers
   `runTool`, `onShutdown`, `startMessageServer` and `call`. Sync lives in core, not in an
   extension, because it rewrites extension approvals (only core may) and must run before the
   extension host reads them. They rely on phase 4's `session.list` for extensions, `caller.cwd`
   and `focus.changed`; without those the Trellis sidebar stays empty and Keeper polls at its
   idle rate. Deferred: opening a specific card or ticket from a notification, navigating an
   already-open panel to a new path.
7. **Remote** (done): phone grant path, input from the phone, attention push, bind-address
   picker with Tailscale detection.

## 5. Guardrails that keep the core lean

- Core main-process budget ~2,500 lines. Crossing it means something belongs in an extension.
- Every built-in extension can be disabled in settings, and disabling it removes its UI and IPC.
- Heavy surfaces (Monaco, webview) load only when a pane first needs them.
- No feature ships UI for something that isn't built (CLAUDE.md §4).
- New agent-facing features ship as extension commands, so the CLI grows through the extension
  API instead of `src/cli/index.ts`.

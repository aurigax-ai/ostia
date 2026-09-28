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

About two thirds of main is features compiled into the core. The plugin system can only contribute
data (themes, locales, language-server specs), not behavior or UI. That's the thing to fix before
adding more features.

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

**First proof:** move kanban and wiki out of core onto this API. If they fit cleanly, the API is
right; core loses ~1,000 lines and two views.

## 3. Features from Warp and cmux, placed

| Feature | From | Ring | Size | Goal |
|---|---|---|---|---|
| Attention model: OSC 9/99/777, `pine notify`/`pine state`, pane rings, sidebar unread badges, jump to latest unread | cmux | core | S–M | 1, 9 |
| Agent hooks recipe: Claude Code `Notification`/`Stop` hooks call `pine state waiting/done` | cmux | extension (docs + skill) | S | 1, 9 |
| Notification center (the bell, backed by the real notify log) | cmux | core | S | 9 |
| Block actions: click to select, copy command/output, jump between blocks, sticky command header | Warp | core | M | 7 |
| Command history search across panes (palette provider) | Warp | core | M | 7 |
| Saved workflows / parameterized commands | Warp | extension | M | 7 |
| Git branch + dirty state in sidebar; listening ports | cmux | built-in extension | M | 3 |
| Diff view (Monaco diff editor) + "open in VS Code / Zed at file:line" | Warp/VS Code | built-in extension | M | 3, 6 |
| Pick element in browser → send selector, screenshot, console errors to an agent pane | new | built-in extension | M | 3 |
| Your real Chrome: document Chrome DevTools MCP for agents instead of re-implementing CDP | new | docs | S | 3 |
| Agent resume on restore (relaunch the agent CLI with its session id) | cmux | built-in extension | M | 5 |
| Trellis board panel, Keeper connection panel | yours | external plugins | M each | 4 |
| Settings sync (git or synced folder) | Warp | extension | S–M | 8 |
| Phone: grant path above read-only, pty input, attention push | cmux-like | built-in extension (gateway) | M | 10 |
| Warp's IDE-style input editor | Warp | **not planned** | L | Clashes with agent TUIs that own the input line |
| Built-in AI chat | Warp | **not planned** | — | Pine hosts agent CLIs; it doesn't compete with them |

## 4. Phases

Each phase ships a working product; nothing half-built lands on `main`.

1. **Attention** (core, small): the attention model, unread badges, jump-to-unread, notification
   center, and the Claude Code hooks recipe. This makes "many agents at once" usable now.
2. **Blocks** (core): block selection, copy output, jump, sticky header, history search.
3. **Extension API v1**: manifest, extension host, commands/events/sidebar items/panel surface.
   Migrate kanban + wiki onto it.
4. **Git & diff** as the first new built-in extension: sidebar branch/dirty, diff view, open in
   external editor.
5. **Browser → agent**: pick element, Chrome DevTools MCP recipe.
6. **Your tools**: Trellis and Keeper plugins; settings sync.
7. **Remote** (done): phone grant path, input from the phone, attention push, bind-address
   picker with Tailscale detection.

## 5. Guardrails that keep the core lean

- Core main-process budget ~2,500 lines. Crossing it means something belongs in an extension.
- Every built-in extension can be disabled in settings, and disabling it removes its UI and IPC.
- Heavy surfaces (Monaco, webview) load only when a pane first needs them.
- No feature ships UI for something that isn't built (CLAUDE.md §4).
- New agent-facing features ship as extension commands, so the CLI grows through the extension
  API instead of `src/cli/index.ts`.

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

**Kanban and wiki removed** (2026-09-28). With Trellis as the user's board and knowledge store
(the `trellis` built-in extension wraps its CLI), pine's own kanban and wiki were redundant and
were deleted: ~965 lines of extension TypeScript plus ~400 of panel HTML/CSS and manifests, the
phone gateway's `board.get`/`board.update` and its `board.read`/`board.write` caps, the
`wiki-read`/`wiki-write`/`board-write` pane caps, the `phone` extension caller kind, and the SDK's
JSON-store helpers that only they used. Built-in extensions are now git, trellis, keeper and system. Old
`.pine/board.json` / `wiki.json` files stay on disk unread.

## 2. Architecture: three rings

```
┌──────────────────────────── external plugins (Trellis, Keeper, yours) ───────────────┐
│ ┌──────────────────────── built-in extensions (ship in the box, can be disabled) ───┐ │
│ │ browser + automation · editor/LSP · files · git/diff · trellis · keeper · vault · │ │
│ │ bus · processes · gateway/remote                                                  │ │
│ │ ┌──────────────────────────── core ───────────────────────────────────────────┐   │ │
│ │ │ windows · workspaces · split panes · pty + shell integration · blocks ·       │   │ │
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
  - sidebar status items per workspace (text + icon + tone, e.g. git branch, ports);
  - pane chips (`contributes.paneChips`: short text on a pane's header, optionally running one
    of the extension's commands) and pane attention (`pane.setAttention` with a target pane);
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
core (both were later removed in favour of Trellis, §1). Their data logic ran in their own
processes, their UI was a panel served by that process, and the CLI forwards any unknown bare
verb to the extension of that id (`pine git status`). Gaps the migration exposed, fixed in the API: commands needed a caller
context (workspace workDir, caller caps) so project-scoped data and conditional permission rules
could live in the extension; commands needed a `stdin` flag and `usage` text so CLI verbs keep
their shape and show up in `pine docs`; panels needed live change push (the SDK's SSE) and the
app theme (`--pine-*` variables). Authoring guide: `docs/EXTENSIONS.md`.

## 3. Features from Warp and cmux, placed

| Feature | From | Ring | Size | Goal |
|---|---|---|---|---|
| Attention model: OSC 9/99/777, `pine notify`/`pine state`, pane rings, sidebar unread badges, jump to latest unread | cmux | core (built) | S–M | 1, 9 |
| Agent hooks recipe: Claude Code `Notification`/`Stop` hooks call `pine state waiting/done` | cmux | extension (docs + skill, built) | S | 1, 9 |
| Notification center (the bell, backed by the real notify log) | cmux | core (built) | S | 9 |
| Block actions: click to select, copy command/output, jump between blocks, sticky command header | Warp | core (built) | M | 7 |
| Command history search across panes | Warp | core (built) | M | 7 |
| Saved workflows / parameterized commands: YAML files (user, project `.pine/workflows`) and extension `contributes.workflows`, picker + argument form inserting at an idle prompt, save from a block or history, `pine workflow list/show` | Warp | core picker + data contributions (built): inserting needs the prompt, which only core may type into | M | 7 |
| Git branch + dirty state in sidebar (built); listening ports and ssh host in the sidebar and as pane chips (built, `ports`) | cmux | built-in extension | M | 3 |
| Diff view (Monaco diff editor) + "open in VS Code / Zed at file:line" (built) | Warp/VS Code | built-in extension + core surface | M | 3, 6 |
| Pick element in browser → send selector, screenshot, console errors to an agent pane | new | with browser automation (built) | M | 3 |
| Your real Chrome: document Chrome DevTools MCP for agents instead of re-implementing CDP | new | docs (built) | S | 3 |
| Agent resume on restore (relaunch the agent CLI with its session id) | cmux | built-in extension | M | 5 |
| Trellis board panel with card deep links from notifications and "Trellis: Open Card", Keeper approvals panel opened on its queue from notifications | yours | built-in extensions (built) | M each | 4 |
| Settings sync (a synced folder you own) | Warp | core (built): it rewrites extension approvals | S–M | 8 |
| Phone: grant path above read-only, pty input, attention push | cmux-like | built-in extension (gateway) | M | 10 |
| Warp's IDE-style input editor (opt-in, only at an idle prompt, so agent TUIs keep the keys) | Warp | core (built) | L | 7 |
| Warp prompt: context chips in the input editor, Edit prompt dialog, plain shell prompt for new shells, extension pane chips in the chip row (built); the `ports` extension publishes ports and ssh login chips (built); no branch or diff stats chip yet | Warp | core (built) + extensions | M | 7 |
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
   Settings → Plugins. Kanban and wiki migrated (since removed for Trellis). Its deferrals
   (pane badges/attention, hot reload, extension settings, pane-scoped methods with an explicit
   target) landed in Extension API v2 (phase 8).
4. **Git & diff** — **done**: the `git` built-in extension (`src/extensions/git/`) shows each
   workspace's branch, ahead/behind and `+new ~changed` in the sidebar, lists staged/unstaged/
   untracked/conflicted files in its panel ("Git: Show Changes"), opens a file's diff, and
   answers `pine git status|changes|diff|open` as JSON. API gaps it exposed, fixed generically:
   `ext.openDiff` with a new core `diff` surface (Monaco diff editor; core knows nothing about
   git), `workspace.list`/`pane.list` for extensions (with `activePaneId`), the caller's `cwd`, and
   a `focus.changed` event so polling pauses when pine isn't focused. Core also gained "Open in
   External Editor" (editor, diff view, palette) driven by `behavior.externalEditor`, spawned
   with argv, never a shell. Deferred: stage/unstage/commit actions, a git-log/blame view, and
   a per-pane branch chip (the API exists since phase 8; the git extension doesn't use it yet).
5. **Browser → agent** — **done**: "Point at element" in browser panes (hover overlay in an
   isolated world, click to capture selector, html, box, style subset, a11y role/name, console
   errors, failed requests, element screenshot), a send panel that writes a markdown report,
   posts a bus message and pastes `@<report>` at the target pane's idle prompt, `pine browse pick`
   for agents to ask the human to click something, and `docs/CHROME.md` for pairing agents with
   the user's real Chrome through Chrome DevTools MCP. It lives next to `browse.ts` in core; since
   phase 8 extensions can drive `browse.*` with an explicit target pane, so it can move out with
   browser automation.
6. **Your tools** — **done**: built-in `trellis` and `keeper` extensions on the public API only
   (panels, per-workspace and global sidebar items, notifications that open the panel, palette
   commands), and settings sync through a user-chosen folder (Settings → Sync). API added for
   them, generic for any extension: `ext.confirm` (a human confirm dialog), `ext.notify
   {openPanel}` (a notification whose click opens your panel), the `shield` icon, and SDK helpers
   `runTool`, `onShutdown`, `startMessageServer` and `call`. Sync lives in core, not in an
   extension, because it rewrites extension approvals (only core may) and must run before the
   extension host reads them. They rely on phase 4's `workspace.list` for extensions, `caller.cwd`
   and `focus.changed`; without those the Trellis sidebar stays empty and Keeper polls at its
   idle rate. Opening a specific card from a notification landed with the tools v2 work below;
   Keeper's dashboard has no per-ticket route, so its notification opens the approvals queue.
7. **Remote** (done): phone grant path, input from the phone, attention push, bind-address
   picker with Tailscale detection.
8. **Extension API v2** — **done**: pane chips (`contributes.paneChips`, `ext.setPaneChip` /
   `ext.clearPaneChip`, badges in the pane header, cleared when the extension stops or the pane
   closes, and placeable in the Pine prompt's chip row through `usePaneChips(paneId)` /
   `usePaneChipCatalog()`); typed extension settings (`contributes.settings`, validated in main, stored under
   `extensionSettings.<id>` in `settings.json`, a form per extension in Settings → Plugins,
   `ext.getSettings` and a `settings.changed` event); hot reload of the user extensions directory
   (added, changed and removed manifests, new ones still wait for approval and new capabilities
   stay unapproved); `targetPaneId` on `browse.*`, `process.*` and `pane.setAttention` for an
   extension holding the method's capability plus `all-workspaces`; and panel paths
   (`ext.openPanel {path}` navigates the open panel in place, `ext.notify {openPanel: path}`).
9. **Tools v2** — **done**: the built-ins on API v2. Trellis notifications open the card
   (`/p/<KEY>/card/<REF>` through the token proxy) and navigate an open panel, "Trellis: Open
   Card" / `pine trellis card <REF>`, settings for which columns notify and the refresh interval.
   Keeper notifications open `/approvals` (no per-ticket route exists in Keeper's UI) and its poll
   intervals and notices are settings. The `ports` extension adds a ports chip (click opens the
   first port in the browser pane) and a `user@host` ssh chip per terminal, with its scan interval
   and link host as settings. API added for them, generic for any extension: a command's
   `argument` (the palette asks for one value and passes it as `argv[0]`), a pane chip `url`
   (opened in the pane's workspace browser pane, so a chip can link without `browse` +
   `all-workspaces`), notification-center entries that keep their panel path, and the SDK's
   `numberSetting`/`booleanSetting`.

## 5. Guardrails that keep the core lean

- Core main-process budget ~2,500 lines. Crossing it means something belongs in an extension.
- Every built-in extension can be disabled in settings, and disabling it removes its UI and IPC.
- Heavy surfaces (Monaco, webview) load only when a pane first needs them.
- No feature ships UI for something that isn't built (CLAUDE.md §4).
- New agent-facing features ship as extension commands, so the CLI grows through the extension
  API instead of `src/cli/index.ts`.

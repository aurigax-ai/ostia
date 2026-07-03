# Pine — Terminal Workspace

The ultimate CLI workspace: a Warp-like terminal + VSCode-like IDE + parallel agent
sessions + a programmable command layer, durable sessions, and a phone companion.
Linux-first, cross-platform later.

> Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Codename `pine` is provisional.

## Status — Phase 0 (designed skeleton)

Running so far:
- Electron + React + TypeScript shell (electron-vite), secure defaults
  (`contextIsolation`, `sandbox`, no `nodeIntegration`).
- **Frameless, OS-native window chrome** (VSCode-style): native traffic lights on macOS
  (left); custom min/max/close on Windows/Linux (right). The top strip is the drag region.
- **Designed view** — the "mission control" look (see [`docs/DESIGN.md`](docs/DESIGN.md)):
  instrument-night palette, mono-forward chrome (Geist), `lucide-react` icons, and the
  **deck rail** whose agent-status channels breathe (the signature). Respects
  `prefers-reduced-motion`.
- **Shell**: a full-width **window + tool control bar** (wordmark · sidebar · settings ·
  command), then **sidebar + work area** beneath it.
- **Workspace → tabs → panes**: each sidebar channel is a *parent* that owns a row of
  **tabs** (cmux-style); each tab owns its own split-tree of panes.
- **Tailwind CSS v4** — design tokens are the `@theme`; chrome is utility-first.
- **Appearance + i18n** (first-class, see [`docs/DESIGN.md`](docs/DESIGN.md)): per-surface
  theme + font (UI · terminal · editor, JetBrains-style); **English + 繁體中文** with
  CJK-safe font fallbacks. Settings via `⌘,` — switching language re-renders live.
- **Command palette** (`⌘K`) over the real command registry. `⌘\` sidebar · `⌘,` settings.
- **Split-tree layout engine** — split ⬌/⬍, resize, close with auto-collapse; unit-tested.
- **Command registry** — the action spine every later caller (palette, CLI, agents, companion) rides on.

> Parked for later: the right **inspector** (code review / agent context) and the bottom
> **status strip** — components kept, not wired into the current shell.

Next: **Phase 1** — a live `zsh` terminal in a pane (xterm.js + node-pty).

## Develop

```bash
npm install
npm run dev        # launch the app (needs a display)
npm run typecheck  # tsc, both configs
npm run lint       # biome
npm test           # vitest (layout tree)
npm run build      # bundle main + preload + renderer
```

## Layout

```
src/
  main/       Electron main (window, IPC) — privileged
  preload/    contextBridge: the typed window.pine surface
  renderer/   React UI
    layout/      pure split-tree model + tests
    stores/      zustand stores (tabs = workspace→tabs→layout, agents, ui, settings)
    commands/    command registry + built-ins
    components/  TopBar, DeckRail, WorkZone (TabStrip + PaneTree), Pane,
                 WindowControls (custom frameless title-bar controls), …
    i18n/        typed catalogs (en + zh-Hant) + useDict
    platform.ts  OS detection for OS-native window chrome
  shared/     types shared across processes
```

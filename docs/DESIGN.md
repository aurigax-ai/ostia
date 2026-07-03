# Pine — Visual Design Language

> The view, designed on purpose. This is the source of truth for look & feel;
> tokens live in `src/renderer/styles/tokens.css`.

## Thesis — "mission control for agents"

Pine is **not a pure terminal**. It's a calm instrument panel for directing terminals,
code, and several AI agents at once. So the chrome stays **quiet and dark**, and the
*life* of the interface comes from **agent status** — what's working, what's waiting on
you, what just finished. You should feel the room is busy without staring at any one pane.

That framing keeps us off the default "near-black + one acid-green accent" dev-tool look:
our energy is warm and signal-driven, not neon.

## Research distilled (what we borrow)

**Warp** — depth from one move, not many colors:
- A translucent **"UI surface"** (light overlay on dark) + a hairline outline = elevation.
  We never invent new background colors for menus/panels; we layer overlays.
- **16 ANSI + a single accent.** The accent appears only where attention should go —
  active tab, active pane, selection. Constraint *is* the aesthetic.
- Command + output grouped into **blocks**; the input is an editor, not a raw prompt.

**cmux** — the left rail is a **live status board**, not just tabs: branch, PR, cwd, ports,
progress. Agents needing attention get a **ring around their pane** + a badge.

## Reference merge — adopt the structure, keep our soul

Two reference builds (an agent-terminal + code-review tool; a Tauri IDE) share a structure we
**adopt without copying their skins**:

- **Three-column workspace:** deck rail · center (terminal/editor) · **right inspector**
  (code review / agent context). We add the inspector as the third column.
- **Ambient agent telemetry:** token/diff counts and **context + weekly budget meters**
  (segmented dotted/filled bars) sit quietly in the chrome, plus agent-control hints
  (`▶▶ accept edits · shift+tab`). We add a usage meter + a hint affordance.
- **Richer rail rows:** a git-branch sub-line per channel.

**What we keep ours (don't copy):** the slate-blue instrument-night palette (the refs run
warm-amber and blue-neutral — we sit deliberately between them), the amber/coral/mint signal
system, and the **breathing** rail — their rails are static; ours reports live state.

**Icons:** `lucide-react` — consistent, light, modern; replaces glyph characters everywhere.

## Palette — "instrument night"

Slate-blue near-black base (not pure black), surfaces built by stacking translucent white,
one warm accent, coral reserved strictly for "needs you."

| Token | Hex | Use |
|-------|-----|-----|
| `--bg` | `#0a0c12` | base canvas (blue-slate, not black) |
| `--bg-sunken` | `#06080d` | wells, gaps between surfaces |
| `--surface-1` | `#10131c` | panes, rail (base + ~3% white) |
| `--surface-2` | `#161a26` | headers, hover (base + ~6%) |
| `--surface-3` | `#1d2230` | popovers, palette (base + ~9%) |
| `--line` | `rgba(255,255,255,.08)` | hairline borders |
| `--line-strong` | `rgba(255,255,255,.15)` | emphasized edges |
| `--fg` | `#e7e9f0` | primary text (cool white) |
| `--fg-muted` | `#8b91a4` | labels, secondary |
| `--fg-dim` | `#565d72` | idle, disabled |
| `--accent` | `#f2b347` | **the one accent** — active/working/selection (warm gold) |
| `--accent-bright` | `#ffc874` | accent hover/peak |
| `--accent-glow` | `rgba(242,179,71,.16)` | focus fills, pane glow |
| `--attn` | `#ff6b5e` | **attention only** — agent waiting / error (coral) |
| `--ok` | `#5bd6a0` | success / done (mint) |

**Agent-state → color** (the only place color carries meaning):
idle `--fg-dim` · working `--accent` (pulsing) · waiting `--attn` (ring) · done `--ok` · error `--attn`.

## Typography — mono-forward console

A deliberate risk that fits the subject: the **chrome itself is monospace**. Tabs, labels,
status, pane titles, numbers — all **Geist Mono** (sleek, geometric, modern — reads as a
developer instrument without the typewriter feel). Prose uses **Geist Sans**, so the whole
type system comes from one family for cohesion.

| Role | Family |
|------|--------|
| Chrome / data / terminal | `Geist Mono` (500/600 for emphasis) |
| Prose / long text | `Geist Sans` |
| Wordmark | Geist Mono, uppercase, tracked `+0.18em` |

Scale is small and tight: 11px labels, 12–13px body chrome, 1.1–1.5 line-height.

## Layout — the shell

A full-width **window + tool control bar** on top; **sidebar + work area** beneath it. The
work area is **tabbed**: each sidebar channel is a *parent* that owns a row of tabs (cmux),
and the active tab hosts its own split-tree of panes.

```
┌──────────────────────────────────────────────────────────────┐
│ 🌲 pine  ▣ ⚙                              ⌕    ─ ▢ ✕        │  window + tool control bar
├────────────┬─────────────────────────────────────────────────┤
│ CHANNELS   │ ◖zsh◗ index.ts  claude            +            │  tabs (active workspace)
│ ● proj/main├─────────────────────────────────────────────────┤
│   working… │                                                 │
│ ● api/fix  │   pane grid for the active tab (split-tree,      │
│   waiting ◹│   elevated surfaces; active pane = amber ring,   │
│ ○ scratch  │   waiting agent = coral ring)                    │
│   idle     │   ┌── pane ───────┐ ┌── pane ──────────┐         │
│            │   │ terminal       │ │ editor            │        │
│  + channel │   └───────────────┘ └───────────────────┘        │
└────────────┴─────────────────────────────────────────────────┘
```

- **Control bar** (top, full width): wordmark · sidebar toggle · settings (left) · **⌘K
  command launcher** (right). OS window controls live beyond it — native traffic lights on
  macOS (left), custom min/max/close on Windows/Linux (right). The whole bar is the drag region.
- **Sidebar / deck rail** (left): channels = workspaces/agents with live status. Collapsible
  to a thin icon rail.
- **Work area** (center): a **tab strip** over the active tab's **pane grid** — panes as
  elevated surfaces with mono headers and an **attention ring** capability.
- **Inspector** (right) and **status strip** (bottom) are designed but **parked** — they
  return as the feature set grows (the inspector likely as a work-area tab or right panel).

## Signature — the deck rail that breathes

The one memorable thing: each rail channel shows its agent's state and **animates** —
working **pulses amber**, waiting shows a **coral ring**, done flashes mint, idle is dim.
Situational awareness becomes the brand. Everything else stays still and disciplined.

## Appearance system — three surfaces, coordinated but independent

Pine themes **three surfaces** that can be styled and fonted *separately* yet stay coordinated —
the JetBrains model (IDE theme ≠ editor scheme; separate appearance vs editor fonts), generalized.

| Surface | What it themes | Theme source | Font |
|---------|----------------|--------------|------|
| **UI chrome** | rail, bars, panels, status, palette | CSS design tokens (Tailwind `@theme`) | UI font (sans) |
| **Terminal** | xterm grid: ANSI-16 + bg/fg/cursor/sel | xterm theme object (Warp YAML / VSCode `terminal.*`) | terminal font (mono) |
| **Editor** | Monaco: TextMate `tokenColors` + `colors` | VSCode theme JSON | editor font (mono) |

**Coordinated, not locked.** A **Theme Pack** supplies coherent values for all three, so "pick one
theme" just works. But each surface can be **overridden independently** (UI = Instrument Night,
editor = Gruvbox, terminal = Solarized), and each carries its **own font** (family/size/line-height/
ligatures). Config shape:

```jsonc
"appearance": {
  "theme": "instrument-night",                 // coordinated base for all three
  "ui":       { "theme": null, "font": { "family": "Geist", "size": 13 } },
  "terminal": { "theme": null, "font": { "family": "Sarasa Mono TC", "size": 13, "lineHeight": 1.4 } },
  "editor":   { "theme": null, "font": { "family": "JetBrains Mono", "size": 13, "ligatures": true } }
}
```
`theme: null` on a surface means "inherit the pack"; set it to override just that surface.

**Engine.** A Theme Pack resolves to three outputs: (a) CSS variables on `:root` for the UI (our
overlay-elevation tokens), (b) an xterm theme object, (c) a Monaco theme. We import **VSCode theme
JSON** (editor + workbench + terminal colors) and/or **Warp YAML** (terminal + accent) and map → all
three, with per-surface override swapping just that output. Changes apply live (CSS vars; `xterm`
`options.theme`; `monaco.editor.defineTheme`).

**Implemented now (foundation):** tokens live in Tailwind `@theme`; the UI font is settable live from
**Settings** (`⌘,`) and applied via `--font-ui`. The per-surface terminal/editor font + theme fields
exist in Settings and persist; they apply once those surfaces are built (Phases 1 & 5). Full
theme-pack import lands in Phase 8.

## Localization & CJK — first-class, from day one

**Locales:** **English (default)** and **Traditional Chinese (`zh-Hant`)**. Resolution is
**variant-aware** — `en-US`/`en-GB` → `en`, `zh-TW`/`zh-HK`/`zh-Hant-*` → `zh-Hant` — so region tags
and future regional overrides have a home. (Simplified is not a target yet.)

**Strings** are never hardcoded: every chrome string comes from a typed catalog (`useDict()` →
`d.section.key`, `fmt()` for `{n}` interpolation), switchable live. Numbers/dates go through `Intl`.
Main-process strings (menus, dialogs) will share the same catalogs.

**CJK is a real constraint, designed in:**
- **Font fallback** — every stack ends in CJK fonts so 繁體中文 always renders even when the primary
  (Geist, no CJK) lacks glyphs: UI → `… "PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC"`;
  mono → `… "Sarasa Mono TC", "Noto Sans Mono CJK TC"`.
- **Terminal width** — CJK glyphs occupy **two cells**. The terminal needs `@xterm/addon-unicode11`
  for correct width *and* a **dual-width mono** (CJK advance = exactly 2× Latin, e.g. Sarasa Mono /
  Noto Sans Mono CJK) so columns stay aligned. We'll bundle one as the default terminal font.
- `<html lang>` tracks the active locale for correct shaping + a11y.

**Implemented now:** the i18n layer (en + zh-Hant) drives the chrome; switching language in Settings
re-renders live in 繁體中文 via the CJK fallback. xterm unicode11 + a bundled dual-width mono arrive
with the terminal (Phase 1).

## Principles

1. **Elevation by translucent surface, never new colors.** (Warp's move.)
2. **One accent (amber).** Coral is sacred — only "needs you."
3. **Motion is ambient and meaningful** — it reports agent state, nothing decorative.
   Respect `prefers-reduced-motion` (drop pulses to static dots).
4. **Mono-forward chrome; sans only for reading.**
5. **Quiet by default, loud exactly where it matters.** Spend boldness on the rail.
6. **Floor, always:** keyboard focus visible, reduced-motion honored, responsive panes.

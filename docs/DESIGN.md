# Design

The source of truth for how pine looks and behaves on screen. Product intent and audience are in
[`PRODUCT.md`](../PRODUCT.md). Tokens live in `src/renderer/index.css`; theme values live in
`src/renderer/plugins/builtin.ts`.

## 1. Thesis

Pine is mission control for terminals and agents. The chrome is quiet and dark. What moves on
screen is session state: what is working and what needs you. Everything else stays still.

Borrowed on purpose:
- **Warp**: elevation comes from a lighter surface plus a hairline outline, not new colors. Uses
  ANSI-16 plus one accent that appears only where attention should go. Commands are grouped into
  blocks.
- **cmux**: the left rail is a live status board, not just a list of tabs.

Avoided: the near-black + acid-green terminal look, IDE toolbar walls, decorative gradients and
glass, and motion that doesn't report state.

## 2. Principles

- **Dense over roomy.** 1px dividers instead of whitespace. Settings can breathe a little more;
  everything else stays dense.
- **Keyboard-first.** Every action has a command and a visible `:focus-visible` ring, and shows
  its shortcut inline. The palette is the discovery surface.
- **One accent.** `--brand` marks active, selected or working. `--attn` is reserved for "needs you"
  and errors.
- **State is never hue-alone.** Every status color is paired with a shape, icon or label.
- **Motion reports state.** 0 ms on the typing path, ≤ 180 ms elsewhere, no spring or bounce.
  Honor `prefers-reduced-motion`.
- **Hierarchy through color and weight, not size.** Keep the type scale narrow.
- **Instant-apply settings.** No Save/Cancel bar except for destructive forms.
- **Semantic tokens only.** Never put a hex value or primitive in a component.
- **One value per axis.** One radius per element class, one emphasis weight (500).

## 3. Tokens

Three tiers in `index.css`:

1. **Primitives**: `--color-*` in `@theme`. A theme remaps these and nothing else. Components
   never use them directly.
2. **Semantic aliases** in `:root`: `--bg`, `--bg-sunken`, `--surface-1..3`, `--line`,
   `--line-strong`, `--fg`, `--fg-muted`, `--fg-dim`, `--brand`, `--brand-bright`, `--brand-glow`,
   `--attn`, `--attn-fg`, `--attn-glow`, `--ok`. Metrics: one radius ladder in `@theme`
   (`--radius-sm` 4px for controls, rows and keycaps; `--radius-md` 6px for inputs, popovers and
   cards; `--radius-lg` 8px), `--radius` 8px for the shadcn bridge, `--rail-w` 240px (56px
   collapsed), `--topbar-h` 36px.
3. **shadcn bridge** in `@theme inline`: maps shadcn names (`--background`, `--primary`, `--muted`,
   `--border`, `--ring`, `--sidebar-*`, …) onto the semantic tokens, so Base UI components in
   `components/ui/` use Pine colors with no per-component work. `--primary` is the brand.
   shadcn's `--accent` is the muted hover surface, not the brand.

Themes are data. Each theme in `plugins/builtin.ts` is a `--color-*` map, and `App.tsx` sets those
values inline on `<html>` at runtime. The values in `@theme` are the Adeberry defaults, which only
show for the first frame before that runs.

**Themes**: `adeberry` (default, a port of Warp's Adeberry), `one-dark-vivid`, `instrument-night`,
`dracula`, `oxocarbon`.

Adeberry values:

| Token | Value | Use |
|---|---|---|
| `--bg` | `#1d2022` | work canvas |
| `--bg-sunken` | `#17191b` | wells, gaps between surfaces |
| `--surface-1` | `#272a2d` | panes, rail |
| `--surface-2` | `#2d3134` | headers, hover, active row |
| `--surface-3` | `#313537` | popovers, palette |
| `--line` / `--line-strong` | `rgba(255,255,255,.07)` / `.13` | hairlines / emphasized edges |
| `--fg` / `--fg-muted` / `--fg-dim` | `#e3edf5` / `#9aa1a5` / `#767d82` | text / secondary text / icons and dividers only |
| `--brand` / `--brand-bright` | `#00d8ff` / `#6cfcf9` | the accent / its hover |
| `--attn` | `#bf5f54` | needs-you, error fills and marks |
| `--attn-fg` | `#db8176` | inline error text |
| `--ok` | `#58c98c` | done, success |
| `--add` / `--del` | `#58c98c` / `#bf5f54` | diffs |

Elevation: `bg-sunken` < `bg` < `surface-1` < `surface-2` < `surface-3`. In the dark theme,
elevation comes from lightness, not shadow; shadows are only for overlays. Every theme keeps
`--fg-muted` ≥ 4.5:1 on `surface-2`, `--attn-fg` ≥ 4.5:1 on `surface-1`, and `--fg-dim` ≥ 3:1 on
`surface-1` (enforced in `plugins/builtin.test.ts`). `--fg-dim` is never text. `<html>` carries
`class="dark"` so shadcn `dark:` variants apply.

Three surfaces take their colors from different places. The UI uses the CSS tokens. The terminal
uses `components/terminalTheme.ts`, because xterm draws to canvas and can't read CSS variables;
only Adeberry and One Dark Vivid have palettes there. The editor uses the one Monaco theme,
`one-dark-vivid`. Changing a theme's colors means updating `builtin.ts` and `terminalTheme.ts`
together.

## 4. Typography

| Surface | Default family | Setting |
|---|---|---|
| UI chrome | Inter Variable (`--font-sans`, applied via `--font-ui`) | `appearance.ui.font` |
| Terminal | Hack Nerd Font Mono (bundled; covers Powerline and icon glyphs) | `appearance.terminal.font` |
| Editor | Geist Mono Variable (`--font-mono`) | `appearance.editor.font` |

Each surface has its own family and size (default 13). The whole UI uses one theme. All chrome
is sans. Use mono only for literal machine text: paths, hashes, ports, code. For changing numbers
in sans text, use `tabular-nums` rather than switching family. Don't set global
`-webkit-font-smoothing: antialiased`, because it thins small text on Linux and macOS.

Scale: `--text-ui-*` in `@theme` (Tailwind `text-ui-*`, CSS `var(--text-ui-*)`). Nothing is
smaller than 11px. Tailwind's `text-sm` is remapped to 13px so shadcn primitives sit on the scale.

| Name | px / line-height | Use |
|---|---|---|
| `ui-xs` | 11 / 16 | captions, metadata, keycaps, badges, all-caps heads |
| `ui-sm` | 12 / 18 | tree and list rows, tooltips |
| `ui-base` | 13 / 20 | primary UI body |
| `ui-emphasis` | 14 / 20 | emphasized body, markdown |
| `ui-lg` | 16 / 22 | section headings, dialog titles |

Weights: 400 body, 500 emphasis (active row, button labels, section heads), 600 headings. Use 700
only at 20px and above; never use 300. Dense rows use a fixed box height (22px at 13px text,
20px at 12px) rather than leading.

Spacing base is 4px: 4, 8, 12, 16, 20, 24, 32. Use 8 within a group, 16–24 between groups and 32
between major sections. Avoid 6, 10 and 14 except as one-off optical fixes.

## 5. Shell layout

```
┌──────────────────────────────────────────────────────────────┐
│ ▣ ⚙                       [ ⌕ command center  Ctrl+Shift+P ] ─ ▢ ✕ │  top bar
├────────────┬─────────────────────────────────────────────────┤
│ Sessions│Files                                                │
│ ◉ ~/proj   │   split tree of panes for the active session     │
│   ~/api  ● │   ┌ pane header ──────┐ ┌ pane header ────────┐  │
│   ~        │   │ terminal          │ │ editor / browser /  │  │
│            │   │                   │ │ kanban / wiki       │  │
│ + session  │   └───────────────────┘ └─────────────────────┘  │
│ ⚙ Settings │                                                  │
└────────────┴─────────────────────────────────────────────────┘
```

- **Top bar**: the sidebar toggle, settings, and the command-center button that opens the
  palette. The whole bar is the window drag region. macOS keeps native traffic lights on the
  left (the bar pads 80px for them). Linux and Windows draw min/max/close on the right
  (`WindowControls.tsx`). There is no wordmark, status strip or inspector.
- **Sidebar** (`DeckRail.tsx`): a Sessions/Files switch; one row per session showing a kind
  icon, workDir and a state dot; "new session"; and a pinned Settings row. It collapses to a
  56px icon rail.
- **Work area**: the active session's split tree, rendered with Allotment. Each pane is an
  elevated surface with a header (title, split right, split down, close). The header is also the
  drag handle for moving panes. The active pane is marked with the brand color. Sessions have no
  tab strip.

## 6. Signature: session status

The one loud element is the state dot on each sidebar row (`.dot` in `index.css`):

| State | Look |
|---|---|
| idle | hidden |
| working | `--brand`, breathing pulse (1.9 s) |
| waiting | `--attn`, expanding ring (1.5 s) |
| done | `--ok`, static |

Only non-idle states show. Today only `working` is derived from live terminal activity (see
ARCHITECTURE.md §5). `waiting` and `done` are styled but nothing sets them yet. Under reduced
motion, animations collapse to static dots and the working dot stays fully opaque.

## 7. Components

- **Library first.** Use shadcn / Base UI (`components/ui/`) for anything with a real interaction
  contract: buttons, inputs, selects, switches, tooltips, dialogs, menus, comboboxes. Skin them
  only through tokens. Never fork a second implementation of the same role.
- **Hand-roll only** when the thing is not a form control: live canvases (xterm, Monaco),
  measured overlays (`Blocks.tsx`), and dense product rows (rail row, pane header). Build one
  shared component per role. Tooltips go through `Hint`, never native `title=`.
- **Settings row**: label (plus an optional description) on the left, control on the right,
  about `py-1.5`. Group heads are `ui-lg`/600 with a `--line` divider. Use rows, not cards,
  unless the item is a separable object with its own actions (a plugin).
- **Controls**: Switch (instant toggle), Select (`size="sm"`, the trigger shows the value), Input,
  Textarea, and ToggleGroup for ≤ 4 short options. Control height is 28px.
- **Icon buttons**: always `IconButton` (ghost button + `Hint` + required `aria-label`). `bar`
  (28px, 16px icon) for the top bar, rail switch and view toolbars; `row` (22px, 14px icon) for
  pane headers, rail rows, the find bar and the browser toolbar. Rest `fg-muted`, hover
  `surface-3` + `fg`, pressed (`aria-pressed`) `surface-3` + `brand`.
- **Icon sizes**: 16 bar-level, 14 rows/headers/buttons, 12 inline glyphs.
- **Status dot or badge**: 6–8px dot plus text.
- **Empty state**: one muted line plus the primary action.
- **Density**: rows are 22–28px, toolbars 32–36px, and settings content is 640–760px wide.

Consolidation debt:
- Primitives still missing: DropdownMenu, ContextMenu, Popover.

## 8. Interaction and accessibility

- **Focus**: a visible ring on every interactive DOM element. Move focus into a surface when it
  opens and restore it when it closes. xterm and Monaco manage their own focus.
- **Keyboard**: in lists and navs, use a roving tabindex with Up/Down/Home/End; Enter or Space
  activates; Escape dismisses. Label every control (`aria-label` or an associated label).
- **Shortcuts**: the palette, sidebar and settings chords are Cmd+K / Cmd+\ / Cmd+, on macOS and
  Ctrl+Shift+P / Ctrl+Shift+B / Ctrl+, elsewhere. In the terminal off macOS, copy, paste and find
  are Ctrl+Shift+C/V/F.
- **Transitions**: 120–180 ms ease. List only the properties that change, never `transition-all`.
- **Overlays**: when a surface covers others, mark the covered subtree `inert` so focus can't
  leak. Hidden sessions use `visibility: hidden` + `inert`.

## 9. Live surfaces (xterm, Monaco, webview)

These are correctness rules, not style:
- **Mount once, keep alive.** Switching sessions or rearranging panes must never remount a
  surface. `SurfacePool` moves persistent host nodes between pane slots.
- **Hide with `visibility: hidden`, not `display: none`**, so the box keeps its size and the fit
  stays valid.
- **Never fit a 0×0 element or forward a 0×0 or unchanged size to the pty.** Resizes are
  debounced and wrapped in rAF (CLAUDE.md §6).
- **Key panes by stable id** so adding or removing a pane never remounts the others.

## 10. Localization

Locales are English (default) and Traditional Chinese (`zh-Hant`). `resolveLocale` maps any
`zh*` tag to `zh-Hant` (Simplified isn't supported, so it maps there too) and everything else to
`en`. Every chrome string comes from the
typed catalog (`useDict()`, `fmt()` for `{n}`), and switching language applies live. `<html lang>`
follows the locale. Font stacks end in CJK fallbacks: PingFang TC, Microsoft JhengHei and
Noto Sans CJK TC for sans; Sarasa Mono TC and Noto Sans Mono CJK TC for mono. The terminal loads
`addon-unicode11` so CJK glyphs take two cells.

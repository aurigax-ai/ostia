# Design

The source of truth for how pine looks and behaves on screen. Product intent and audience are in
[`PRODUCT.md`](../PRODUCT.md). Tokens live in `src/renderer/index.css`; theme values live in
`src/renderer/plugins/builtin.ts`.

## 1. Thesis

Pine is mission control for terminals and agents. The chrome is quiet and dark. What moves on
screen is workspace state: what is working and what needs you. Everything else stays still.

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
- **Motion reports state.** 0 ms on the typing path, ≤ 220 ms elsewhere, no spring or bounce.
  Honor reduced motion (§8).
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
   (`--radius-sm` 6px for controls, rows and keycaps; `--radius-md` 8px for inputs, popovers and
   cards; `--radius-lg` 10px), `--radius` 10px for the shadcn bridge, `--rail-w` 240px (56px
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
│ Workspaces│Files                                                │
│ ◉ ~/proj   │   split tree of panes for the active workspace     │
│   ~/api  ● │   ┌ pane header ──────┐ ┌ pane header ────────┐  │
│   ~        │   │ terminal          │ │ editor / browser /  │  │
│            │   │                   │ │ extension panel     │  │
│ + workspace  │   └───────────────────┘ └─────────────────────┘  │
│ ⚙ Settings │                                                  │
└────────────┴─────────────────────────────────────────────────┘
```

- **Top bar**: on the left, over the sidebar: the sidebar toggle, the Files toggle, one toggle
  per enabled extension panel (git Changes, Keeper, Trellis; `PanelToggles.tsx`, pressed while the
  panel is open in the active workspace), then New workspace and Settings at the sidebar's right
  edge. Centre: the command-center button that opens the palette. Right: the notification bell.
  The whole bar is the window drag region. macOS keeps native traffic lights on the left (the bar
  pads 80px for them). Linux and Windows draw GNOME-style round min/max/close buttons on the right
  (`WindowControls.tsx`, 24px circles). There is no wordmark, status strip or inspector.
- **Sidebar** (`DeckRail.tsx`): only workspaces: one row per workspace showing a kind icon, a
  state dot, an unread badge and the details chosen in Settings → Sidebar, plus a pinned Settings
  row. It collapses to a 56px icon rail.
- **Files panel** (`FilesPanel.tsx`): a 260px column to the right of the sidebar, toggled from the
  top bar. It shows the active workspace's focused pane cwd, so switching workspaces switches it.
- **Cursor**: the normal arrow everywhere, like a desktop app. No pointer or grab cursors.
- **Work area**: the active workspace's split tree, rendered with Allotment. Each pane is an
  elevated surface with a header (title, split right, split down, close). The header is also the
  drag handle for moving panes. Focus follows cmux: no border around the focused pane; the
  selected tab carries a 2px top line (brand in the focused pane, `--line-strong` elsewhere), and
  in a split every unfocused pane's body is dimmed by a `--bg` overlay at 30% (cmux's
  `unfocused-split-opacity` 0.7). Tabs are square and flush. Workspaces have no tab strip.

## 6. Signature: workspace status

The loudest element is the state dot on each sidebar row (`.dot` in `index.css`):

| State | Look |
|---|---|
| idle | hidden |
| working | `--brand`, ambient breathe, opacity .55 ↔ 1 (2.4 s, loops) |
| waiting | `--attn`, expanding ring (1.5 s) three times, then steady; replays on a new waiting signal |
| done | `--ok`, static |
| error | `--attn`, static, square (so it differs from waiting by shape, not only motion) |

Only non-idle states show; each dot has an `aria-label` with the state name. The state comes from
the workspace's panes (ARCHITECTURE.md §5, "Live workspace state and attention"). Under reduced
motion, animations collapse to static dots and the working dot stays fully opaque.

Attention, the second loud element, appears only when a pane needs you:

- **Pane ring**: an unread `waiting` or `error` pane gets a 2px inset `--attn` ring (the active
  pane's ring is 1px `--brand`). It fades in, pulses twice, then holds; only a new signal to that
  pane replays the pulse. Its header shows a mark (circle for
  waiting, square for error) labelled "Needs attention" plus the message in `--attn-fg`.
- **Quiet marker**: an unread `done` pane (or one that rang the bell) gets only the header mark
  (`--ok` circle for done, `--fg-muted` otherwise) labelled "Unread", plus the message in
  `--fg-muted`. No ring.
- **Unread badge**: the workspace row shows the number of unread panes as an outlined pill
  (`--attn` border, `--attn-fg` number, `ui-xs`/500, tabular). A number, so never hue-alone. It
  pops in once (scale .85 → 1 + fade) when it appears or its count grows; never on a decrease.
- **Bell**: a `bar` IconButton in the top bar's right slot. Its count uses the same pill; its
  label reads "Notifications, N unread". The popover lists the notification log newest first:
  `workspace · pane` and time on a `ui-xs` meta line, the message in `ui-sm`. Each row jumps to its
  pane; rows for closed panes are disabled. "Clear all" sits in the header.

## 7. Components

- **Library first.** Use shadcn / Base UI (`components/ui/`) for anything with a real interaction
  contract: buttons, inputs, selects, switches, tooltips, dialogs, menus, comboboxes. Skin them
  only through tokens. Never fork a second implementation of the same role.
- **Hand-roll only** when the thing is not a form control: live canvases (xterm, Monaco),
  measured overlays (`Blocks.tsx`), and dense product rows (rail row, pane header). Build one
  shared component per role. Tooltips go through `Hint`, never native `title=`.
- **Settings row**: label (plus an optional description) on the left, control on the right,
  about `py-1.5`. Group heads are `ui-lg`/600 with a `--line` divider. Use rows, not cards,
  unless the item is a separable object with its own actions (a plugin). The shared pieces live
  in `SettingsPanel.tsx`: `SectionHead` (title + optional `ui-sm` intro), `SubHead` (`ui-base`/500
  for a group inside a section), `ControlRow`, and `WarningNote` (the one warning callout).
  Version numbers are sans `tabular-nums`, not mono.
- **Controls**: Switch (instant toggle), Select (`size="sm"`, the trigger shows the value), Input,
  Textarea, and ToggleGroup for ≤ 4 short options. Control height is 28px.
- **Icon buttons**: always `IconButton` (ghost button + `Hint` + required `aria-label`). `bar`
  (28px, 16px icon) for the top bar and view toolbars; `row` (22px, 14px icon) for
  pane headers, rail rows, the find bar and the browser toolbar. Rest `fg-muted`, hover
  `surface-3` + `fg`, pressed (`aria-pressed`) `surface-3` + `brand`.
- **Icon sizes**: 16 bar-level, 14 rows/headers/buttons, 12 inline glyphs.
- **Status dot or badge**: 6–8px dot plus text.
- **Empty state**: one muted line plus the primary action. The work zone with no workspaces
  (`WorkZone.tsx` `NoWorkspaces`) is the reference: centered `ui-lg`/600 heading "No workspaces",
  one `ui-base` `fg-muted` sentence, and a default (brand) `Button` "New workspace" with its chord
  (`chordLabel('workspace.new')`) in a `ui-xs` keycap. No illustration, no sample content. It
  fades in once (`--motion-base`).
- **Density**: rows are 22–28px, toolbars 32–36px, and settings content is 640–760px wide.

- **Popover**: `components/ui/popover.tsx` (Base UI), skinned via `className`; the notification
  center is the reference (`surface-3`, `radius-md`).

Consolidation debt:
- Primitives still missing: DropdownMenu. ContextMenu (`components/ui/context-menu.tsx`) backs
  the block menu.

## 8. Interaction and accessibility

- **Focus**: a visible ring on every interactive DOM element. Move focus into a surface when it
  opens and restore it when it closes. xterm and Monaco manage their own focus.
- **Keyboard**: in lists and navs, use a roving tabindex with Up/Down/Home/End; Enter or Space
  activates; Escape dismisses. Label every control (`aria-label` or an associated label).
- **Shortcuts**: the palette, sidebar, settings, jump-to-latest-unread, command-history and
  new-workspace chords are Cmd+K / Cmd+\ / Cmd+, / Cmd+Shift+U / Cmd+Shift+H / Cmd+T on macOS and
  Ctrl+Shift+P / Ctrl+Shift+B / Ctrl+, / Ctrl+Shift+U / Ctrl+Shift+H / Ctrl+Shift+T elsewhere. In the terminal, previous/next
  block is Cmd+↑/↓ (Ctrl+Shift+↑/↓ elsewhere) and Escape clears a block selection; off macOS,
  copy, paste and find are Ctrl+Shift+C/V/F.
- **Transitions**: motion tokens only (§8 Motion). List only the properties that change, never
  `transition-all`.
- **Overlays**: when a surface covers others, mark the covered subtree `inert` so focus can't
  leak. Hidden workspaces use `visibility: hidden` + `inert`.

### Motion

Motion reports state or confirms an action; it never decorates. Tokens live in `:root` in
`index.css`:

| Token | Value | Use |
|---|---|---|
| `--motion-fast` | 90 ms | hover/focus color feedback, tooltips, block selection frame |
| `--motion-base` | 150 ms | overlays, badge pop, sticky header, find bar, new pane content, ring fade-in |
| `--motion-slow` | 220 ms | sidebar collapse width |
| `--motion-fast-exit` / `--motion-base-exit` | 63 / 105 ms | exits, about 70% of the enter |
| `--motion-pulse` | 1.5 s | one attention pulse (ring, waiting dot) |
| `--motion-breathe` | 2.4 s | the working dot's loop |
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | every enter and every hover |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | every exit |
| `--ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | the breathe loop only |

Tailwind's `transition-*` utilities default to `--motion-fast` / `--ease-out`.

Where it moves:
- **Overlays** (palette, dialogs, context menu, select, popovers such as the notification
  center): `motion-overlay`, fade + scale .98 → 1 from Base UI's `--transform-origin` (the
  palette scales from its top), exit fade + scale to .98 with `--ease-in`. Dialog backdrops fade
  (`motion-backdrop`). Tooltips (`Hint`): `motion-hint`, opacity only, `--motion-fast`.
- **Attention**: the pane ring, the waiting dot, the working dot and the unread badge (§6).
- **Blocks**: the selection frame fades in; the sticky command header slides down 4px + fades
  in and leaves faster the way it came; the find bar enters from 6px above.
- **New pane content** fades in once when its surface is created (`.surface-enter`), never when
  a surface moves between slots. The no-workspaces empty state fades in the same way.
- **Hover/focus/active**: color, background and border at `--motion-fast`.

What stays still: pane size, position and splits; the Allotment sashes; anything that resizes
an xterm host (it would fit and resize the pty every frame); buttons on press (no scale or
nudge); lists (no stagger); workspace switches and Settings (no page transitions). Nothing
springs, bounces or overshoots. The one width transition is the sidebar collapse, which is
safe because terminal resizes are debounced.

Reduced motion: `appearance.motion` (Settings → Appearance → Motion) is `system` (follow
`prefers-reduced-motion`), `reduced` or `full` (ignore the OS), mirrored to `<html
data-motion>`. Reduced collapses every duration and delay to ~0 and runs loops once, so pulses
become static indicators; the dots, ring and badge still show the state.

## 9. Live surfaces (xterm, Monaco, webview)

These are correctness rules, not style:
- **Mount once, keep alive.** Switching workspaces or rearranging panes must never remount a
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

## 11. App icon

Two pines, a tall one in front of a smaller one: a small forest, the way Pine runs many terminals
and agents side by side. Stepped tiers make them read as pines rather than generic triangles, and
the front tree is outlined in the tile colour so the overlap stays crisp. Two colours only, natural
and warm on purpose (the app chrome stays on the Adeberry tokens): sand `#F0E9DD` tile, bark
`#6A4B33` trees.

- Source: `resources/icon.svg`. It holds up at 16 px, so every size renders from the one file.
- `pnpm icons` renders `resources/icons/NxN.png` (16–512) and `resources/icon.png` (the window
  icon) with `rsvg-convert`. Commit the PNGs; the build doesn't rasterise.
- `scripts/install-linux.sh` installs every size into the user's `hicolor` theme plus the SVG as
  `scalable`, and the desktop entry uses `Icon=<product name>`.

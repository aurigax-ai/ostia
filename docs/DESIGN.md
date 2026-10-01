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
values inline on `<html>` at runtime (`lib/theme.ts` `applyTheme`, which also sets `data-theme` and `color-scheme`). The values in `@theme` are the Adeberry defaults, which only
show for the first frame before that runs.

**Themes**: `adeberry` (default, a port of Warp's Adeberry), `one-dark-vivid`, `instrument-night`,
`dracula`, `oxocarbon`, and the only light theme, `pine-light`. Each names a color scheme
(`colorScheme`) of the same id, so picking a theme also gives the terminal and the editor
matching colors (section "Three color axes" below).

`pine-light` values: `--bg` `#f6f7f9`, `--bg-sunken` `#eceef2`, `--surface-1/2/3` `#ffffff` /
`#f0f2f5` / `#e6e9ee`, `--line` / `--line-strong` `rgba(0,0,0,.09)` / `.16`, `--fg` `#1c2127`,
`--fg-muted` `#4f5866`, `--fg-dim` `#6b7280`, `--brand` / `--brand-bright` `#0b62c4` / `#084b96`,
`--attn` / `--attn-fg` `#b3382c` / `#a12f24`, `--ok` / `--add` `#15703f`, `--del` `#b3382c`. Its
`pine-light` color scheme (`#fbfcfd` background) is tuned so every ANSI text color reads at 4.5:1
or better (checked in `plugins/builtin.test.ts`). Scrollbar thumbs derive from `--line-strong` / `--fg`, so
they work on both appearances.

**Appearance settings.** `appearance.followSystem` switches between `lightTheme` and
`darkTheme` with the OS (main pushes `nativeTheme` changes; `systemThemeStore`). Off, `theme`
applies. `appearance.accent` (`#rgb`/`#rrggbb`, validated by `lib/color.ts`) replaces `--brand`
and derives `--brand-bright` and `--brand-glow`; a color that would fall below 4.5:1 on the
theme's `--bg` is darkened (light) or lightened (dark) until it reads. Text on a brand fill is
always `--on-brand` (`--color-on-brand`, computed for every theme, with or without an accent,
by `readableOn`): the theme's `--bg` if it reads at 4.5:1 on the brand, else its `--fg`, else
near-black or white. So a light accent such as `#f2b347` on a dark theme gets dark text, and the
same accent on `pine-light` (darkened to read on the light background) gets light text.
`--primary-foreground` and `--sidebar-primary-foreground` point at it, so every primary button,
badge, checked switch and radio uses it. Everything that marks active, selected or working reads
`--brand` (or `--primary`, `--ring`, `--focus-border`, `--sidebar-primary`, which point at it):
focus rings, the active pane tab's underline, the working dot, drop indicators, block gutter
bars, pane chips. With a linked terminal or editor scheme the accent is also the cursor color.
Settings → Appearance shows the preset swatches plus a custom swatch (a native color input)
that is filled with the accent only when the accent is not a preset. `appearance.zoom` (80 to 150, Ctrl/Cmd `=`, `-`, `0`) scales the window through
`webContents.setZoomFactor`.

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

Workspace group colors are a separate label palette: `--group-red`, `--group-orange`,
`--group-yellow`, `--group-green`, `--group-teal`, `--group-blue`, `--group-purple`,
`--group-pink` (primitives `--color-group-*`, One Dark hues by default; a theme may remap them).
They only tint a group's swatch and its member rule, never text or state; the group's name
always carries its identity. The one other use is the Git graph's lanes (`--lane-0..7` in the
git panel, each group hue mixed 72% with `--fg` so it holds contrast on light and dark themes):
a lane color only tells branches apart, and the ref badge names the branch. Panels get the
palette as `--group-*` from the SDK's base CSS. Pine's own file-type icon tints use the same
mix (`fileIcon.ts`), never fixed hex values, so they follow the theme too. Uncommitted work in the graph is drawn dashed
and hollow, never by color alone.

Elevation: `bg-sunken` < `bg` < `surface-1` < `surface-2` < `surface-3`. In the dark theme,
elevation comes from lightness, not shadow; shadows are only for overlays. Every theme keeps
`--fg-muted` ≥ 4.5:1 on `surface-2`, `--attn-fg` ≥ 4.5:1 on `surface-1`, and `--fg-dim` ≥ 3:1 on
`surface-1` (enforced in `plugins/builtin.test.ts`). `--fg-dim` is never text. `<html>` carries
`class="dark"` only while the effective theme is dark (`applyTheme` toggles it with
`color-scheme`), so shadcn `dark:` variants style dark themes and its light styles apply under
`pine-light`: a light theme never gets a dark switch thumb or dark-tinted inputs.

### Three color axes

Three surfaces take their colors from different places, one setting each:

| Axis | Setting | Source |
|---|---|---|
| UI (sidebar, tabs, menus, dialogs) | `appearance.theme` (+ `followSystem`, `lightTheme`, `darkTheme`) | the theme's CSS tokens |
| Terminal | `terminal.theme` | a color scheme: 16 ANSI colors + background, foreground, cursor, cursor text, selection |
| Editor (Monaco, diff, chat code blocks) | `editor.theme` | Monaco theme derived from a color scheme |

`terminal.theme` and `editor.theme` are `"match"` by default: linked to the Pine theme, they use
the scheme the effective theme names, so they follow the light/dark switch too. Turning off
"Match pine theme" on a row stores the scheme then in use and shows a searchable picker (each
entry shows its background and six ANSI hues); from then on that axis keeps its scheme whatever
the theme is. An unknown scheme id falls back to the linked scheme. Settings → Appearance shows a
live preview under the rows: a terminal sample (prompt, pass/fail/warn lines, all 16 ANSI
swatches) in the terminal scheme and a code sample in the editor scheme, drawn with the same
colors the terminal and Monaco get.

Monaco's theme is global, so anything that colorizes with it applies the editor scheme first:
a chat code block (`ai-elements/code-block.tsx`) paints its body in the editor scheme's
background and foreground and re-colorizes when the scheme changes, even when no editor is open.

The editor theme is derived, not hand-written (`monaco/monacoTheme.ts`): keywords magenta,
strings green, functions blue, types yellow, numbers and constants a red/yellow mix, variables and
tags red, operators cyan, comments bright black in italics. Every token color is lifted to 4.5:1
on the background (comments and line numbers to 3:1) with `ensureContrast`, so faint ANSI
colors (Solarized's yellow, a bright black equal to the background) still read.

Color schemes (`plugins/colorSchemes.ts`, contributed by the `pine.themes` plugin as
`contributes.colorSchemes`; a plugin can add more the same way):

| Scheme | Source |
|---|---|
| Adeberry | Warp's built-in Adeberry theme, sampled from the Warp app |
| One Dark Vivid, Instrument Night, Pine Light | Pine's own |
| Dracula, Oxocarbon | Ghostty theme files (mbadolato/iTerm2-Color-Schemes, `ghostty/`) |
| Catppuccin Mocha, Macchiato, Frappé, Latte | Ghostty theme files |
| Tokyo Night, Tokyo Night Day | Ghostty `TokyoNight`, `TokyoNight Day` |
| Gruvbox Dark, Gruvbox Light | Ghostty theme files (the same values as warpdotdev/themes `gruvbox_*.yaml`) |
| Nord | Ghostty theme file |
| Solarized Dark | Ghostty `iTerm2 Solarized Dark` (Warp's copy has bright black equal to the background) |
| Solarized Light | warpdotdev/themes `solarized_light.yaml` (foreground base01; the iTerm2 base00 reads at 4.1:1) |
| Rosé Pine, Rosé Pine Dawn | Ghostty `Rose Pine`, `Rose Pine Dawn` |
| Kanagawa Wave | Ghostty theme file |
| Everforest Dark, Everforest Light | Ghostty `Everforest Dark Hard`, `Everforest Light Med` |
| GitHub Dark, GitHub Light | Ghostty `GitHub Dark Default`, `GitHub Light Default` |
| One Half Light | Ghostty `One Half Light` (Atom One Light's syntax colors) |
| Monokai Classic | Ghostty `Monokai Classic`, cmux's built-in default terminal theme |

Every scheme has all 16 ANSI colors and a foreground at 4.5:1 or better on its background
(`plugins/colorSchemes.test.ts`). Oxocarbon's selection text is its foreground (the file's
`#626262` was unreadable on its selection). Changing a Pine theme's colors means updating
`builtin.ts` and, when its terminal should change too, its scheme in `colorSchemes.ts`.

## 4. Typography

| Surface | Default family | Setting |
|---|---|---|
| UI chrome | Inter Variable (`--font-sans`, applied via `--font-ui`) | `appearance.ui.font` |
| Terminal | Hack Nerd Font Mono (bundled; covers Powerline and icon glyphs). MesloLGS Nerd Font Mono (Apache-2.0) is bundled too and appears in the font picker | `appearance.terminal.font` |
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
│ + ▣                       [ ⌕ command center  Ctrl+Shift+P ] ─ ▢ ✕ │  top bar
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

- **Top bar**: on the left, over the sidebar: New workspace first, then the sidebar
  toggle, the Files toggle and one toggle per enabled extension panel (git Changes, Keeper,
  Trellis; `PanelToggles.tsx`, pressed while the panel is open in the active workspace). The
  assistant has no panel; it is configured in Settings → Assistant.
  Centre: the command-center button that opens the palette, then the Assistant menu. Right:
  Settings, then the notification bell. Every trigger renders exactly one `<button>` (Base UI
  `render={<IconButton …/>}`, never a Trigger wrapping a button as its child).
  The whole bar is the window drag region. macOS keeps native traffic lights on the left (the bar
  pads 80px for them). Linux and Windows draw GNOME-style round min/max/close buttons on the right
  (`WindowControls.tsx`, 24px circles). There is no wordmark, status strip or inspector.
- **Sidebar** (`DeckRail.tsx`): only workspaces: one row per workspace showing a kind icon, a
  state dot, an unread badge and the details chosen in Settings → Sidebar, plus a pinned Settings
  row. It collapses to a 56px icon rail.
  - **Group header** (cmux's workspace groups): a 24px `ui-xs`/500 uppercase row with a 12px
    caret (right when collapsed, down when open), an 8px `radius 2px` swatch in the group color
    (`--line-strong` without one), the name, the member count (`fg-muted`, tabular), then the
    members' strongest state dot and their summed unread badge. Both stay on a collapsed header,
    so a collapsed group still says a member needs you. Click toggles, double-click renames,
    the context menu renames, recolors (radio list with chips), collapses, marks read and
    deletes (members stay, ungrouped). Members sit 24px in, next to a 2px rule in the group
    color. The header has no active state of its own; while the active workspace hides inside a
    collapsed group the header text turns `fg`. Collapsing is instant: rows are added and
    removed, never animated.
  - **Drag**: rows and group headers drag with the same 2px `--brand` insertion line as reorder;
    dropping onto the lower half of a header highlights it (`--brand-glow` + 1px `--brand`
    inset) and means "into this group". While dragging, the empty space below the list is a drop
    zone for "last, ungrouped".
  - **Workspaces in other windows** follow the main window's own rows, in window order: same row
    layout, the kind icon replaced by `AppWindowIcon` (the "in another window" mark), the state
    dot kept, the folder as the meta line, no close button and never an active highlight. A
    click focuses their window; the context menu offers Show window and Move back to main
    window. They take the next workspace digits, so Ctrl/⌘+1..9 reach them.
- **Detached window** (`DetachedTitleBar.tsx`): no sidebar and no top-bar tools. The bar holds
  only a Move back to main window icon button (`ArrowSquareInIcon`) on the left, the project name
  centered (`ui-base`/600, `fg`, truncated) and the window controls; all of it is the drag
  region. The work area below is the same split tree.
- **Files panel** (`FilesPanel.tsx`): a 260px column to the right of the sidebar, toggled from the
  top bar. It shows the active workspace's focused pane cwd, so switching workspaces switches it.
  Its header holds three row-size `IconButton`s, right-aligned: the eye (show hidden files,
  `aria-pressed`), view options (a `DropdownMenu` from `Menu.tsx`: compact folders, nesting,
  show hidden files, sort, icon theme) and close. Every option is also in Settings → Files.
  Hidden rows shown by the eye are dimmed to 55% opacity. A compact folder row joins its names
  with a muted `/`. A nesting parent has a twisty: the twisty or ArrowRight/ArrowLeft expands
  it, a click on the name opens the file.
  - **File icons**: Pine's own are Phosphor at 14px, tinted per type (`fileIcon.ts`). A VS Code
    icon theme an extension contributes replaces them with its own images at 16px. These are
    the user's content, the one place non-Phosphor icons appear in the app's chrome.
- **Cursor**: the normal arrow everywhere, like a desktop app. No pointer or grab cursors.
- **Work area**: the active workspace's split tree, rendered with Allotment. Each pane is an
  elevated surface with a header (title, split right, split down, close). The header is also the
  drag handle for moving panes. Focus follows cmux: no border around the focused pane; the
  selected tab carries a 2px top line (brand in the focused pane, `--line-strong` elsewhere), and
  in a split every unfocused pane's body is dimmed by a `--bg` overlay at 30% (cmux's
  `unfocused-split-opacity` 0.7; Settings → Panes → Dim inactive panes turns it off). Tabs are square and flush. Workspaces have no tab strip.

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
- **Settings numbers** (`NumberRow`): a number input that commits only in-range values while you
  type and snaps back to the stored value on blur, so typing `5000` never passes through a clamped
  `5`. Risky-paste confirmation is a shadcn `Dialog` with a monospace, scrollable preview.
- **Settings row**: label (plus an optional description) on the left, control on the right,
  about `py-1.5`. Group heads are `ui-lg`/600 with a `--line` divider. Use rows, not cards,
  unless the item is a separable object with its own actions (a plugin). The shared pieces live
  in `SettingsPanel.tsx`: `SectionHead` (title + optional `ui-sm` intro), `SubHead` (`ui-base`/500
  for a group inside a section), `ControlRow`, and `WarningNote` (the one warning callout).
  Version numbers are sans `tabular-nums`, not mono. `SettingsGroup` takes an optional one-line
  `desc` and a right-aligned `action` (an "Add …" button or a refresh `IconButton`).
- **Settings lists** of configured objects (MCP servers, skill folders, models in Settings →
  Assistant): shadcn `Item` rows (`outline`, `sm`, `radius-md`, `--line` border) in a `ul`, each
  with a title, a mono `ui-xs` target line, a status line (6px dot + text, `attn-fg` error
  message under it) and `ItemActions` (switch, edit, remove as `row` `IconButton`s). Adding or
  editing opens a shadcn `Dialog` with labeled fields and inline `role="alert"` errors; removing
  an object that loses data confirms in a `Dialog`. An empty list is a dashed `Empty` with a
  title, one muted line and the add button. Security and limits live in the docs, not in helper
  text: at most one short line per group.
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
  center is the reference (`surface-3`, `radius-md`). Its section labels ("Permission requests",
  workspace group heads) are `ui-xs`/500 `fg-muted`.
- **Section tabs** (`SectionTabs.tsx`: `SectionTabsList`, `SectionTab`): the one tab strip for
  switching views inside a surface (notification center filters, the workspace sandbox page, the
  browser storage drawer). shadcn `Tabs` `line` variant: square, flush on a `--line` bottom rule,
  `ui-sm` labels in `fg-muted`, hover `fg`, the selected tab `fg`/500 with a 2px `--brand`
  underline (like the selected pane tab's brand line), an inset `--ring` on `:focus-visible`.
  Counts sit after the label (`tabular-nums`; `attn-fg` for "Needs you"). Never the segmented
  `default` variant.
- **File viewers** (image, PDF): a view toolbar (`.viewer-toolbar`, `surface-2`, `--line`
  bottom border, `bar` icon buttons) over a `bg-sunken` stage with 16px padding. Order: file
  name (`ui-sm`, truncates first), meta in mono `ui-xs` `fg-muted` `tabular-nums` (image size,
  "Page n of m"), page arrows, zoom out / "Zoom n%" / zoom in / fit (pressed while fitting),
  the PDF region toggle, clear region, and the send button last (`PaperPlaneTiltIcon`; its label
  says what will be sent: region, selected text, image or page). Images sit on a
  `surface-2`/`surface-3` checkerboard so transparency reads; a PDF page is the rendered paper
  with a `--line-strong` outline and no shadow. A drawn region is a 1px `--brand` rectangle over
  `--brand-glow`; PDF text selection uses `--brand-glow` too. A one-line `viewer-hint` bar (same
  style as the browser's pick hint) explains region mode. Errors and "Loading…" use the ghost
  empty line. The cursor stays the default arrow everywhere, including while dragging a region.
- **Send panel** (`PickSendPanel.tsx`): one component for pick element and file-view selections.
  It floats top-right of its surface (`surface-3`, `radius-md`, overlay shadow): title, a mono
  `ui-xs` summary of what is being sent (`file:line:col-line:col`, `file (x, y, w × h)`,
  `file, page n`), the note, and the target radio list with state dots. The result shows as a
  small `viewer-status` chip bottom-right for 6 s.

- **Terminal input editor** (`InputEditor.tsx`, `behavior.inputMode: 'editor'`): drawn in
  place over the shell's input line, in the terminal font, size and cell grid, on the terminal
  theme background, with no border, radius or padding, so it reads as the shell's own line. The
  shell's prompt stays to its left; with the Pine prompt a chip row (chips at the cell height)
  replaces the cwd line above. Placeholder "Run commands" in `fg-muted`. The completion menu
  and the "No matching paths" note are popovers (`surface-1`, `--line` border, `radius-md`)
  above the line, or below it when the prompt is in the upper half. The vim badge sits at the
  right end of the line. It appears and disappears without animation (§8 Motion).

- **Declarative views** (`DeclarativeView.tsx`): an agent's JSON is drawn only with these
  components, so it can't look foreign. Sidebar views sit under the workspaces in `.rail-views`
  (a `--line` rule above), each headed like `.rail-section` (`ui-xs`/500 uppercase `fg-muted`,
  caret + icon, collapsible) with the body indented to the title; the rail uses `xs` buttons and
  12px icons, a panel uses `sm` buttons and 14px icons on `surface-1`, max 760px wide. Tones map
  to tokens only (`neutral` fg, `muted` fg-muted, `brand`, `ok`, `warn`/`error` attn-fg); icons
  never take `brand`. Badges are outline, 16px high, tone-colored text and border. Progress is
  the shadcn bar on a `surface-3` track. Problems (over budget, a broken file showing its last
  good version) are one compact attention alert above the view, never a replaced view.

Menus: `DropdownMenu` in `components/Menu.tsx` is Base UI `Menu.Root` + `Menu.Trigger` filled with
the same popup parts as the context menu (Base UI's ContextMenu reuses the Menu parts), so both
menus share one row, icon column and hint style.

**Context menus** go through `components/Menu.tsx` (`MenuContent`, `MenuItem`, `MenuSubTrigger`,
`MenuSubContent`, `MenuRadioItem`) over the shadcn ContextMenu, never the raw `ContextMenuItem`:
`ui-base` labels, 28px rows, a fixed 14px leading column (a Phosphor icon, a state dot or color
chip, or empty space) so every label shares one left edge, and right-aligned `ui-xs` hints only
for real chords. Order groups open → reveal → copy → send, then destructive last after a
separator. The row a menu belongs to shows it with `[data-popup-open]` (surface-2 plus a
`--line-strong` inset for tree rows). Empty submenus say why in one disabled row.

## 8. Interaction and accessibility

- **Focus**: a visible ring on every interactive DOM element. Move focus into a surface when it
  opens and restore it when it closes. xterm and Monaco manage their own focus.
- **Keyboard**: in lists and navs, use a roving tabindex with Up/Down/Home/End; Enter or Space
  activates; Escape dismisses. Label every control (`aria-label` or an associated label).
- **Shortcuts**: the palette, sidebar, settings, jump-to-latest-unread, command-history and
  new-workspace chords are Cmd+K / Cmd+\ / Cmd+, / Cmd+Shift+U / Cmd+Shift+H / Cmd+T on macOS and
  Ctrl+Shift+P / Ctrl+Shift+B / Ctrl+, / Ctrl+Shift+U / Ctrl+Shift+H / Ctrl+Shift+T elsewhere. In the terminal, previous/next
  block is Cmd+↑/↓ (Ctrl+Shift+↑/↓ elsewhere) and Escape clears a block selection; off macOS,
  copy, paste and find are Ctrl+Shift+C/V/F. These are defaults: Settings → Keyboard rebinds or
  unbinds any of them and binds any palette command. Every place that shows a chord reads it
  through `chordLabel`/`useChordLabel`, and hides the keycap when the command is unbound.
- **Keyboard settings**: a search field and "Reset all" over a shadcn `Table` (command title with
  its id in `ui-xs` mono `fg-muted`, the shortcut in a `Kbd`, then Record and Reset buttons).
  Recording replaces the keycap with a polite live "Press a shortcut… Esc cancels". A refused
  chord shows one `attn-fg` `ui-sm` line (`role="alert"`) under it; a conflict or Monaco clash
  shows a `WarningNote` with Replace / Use anyway and Cancel. No motion beyond the shared
  button feedback.
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
| `--motion-highlight` | 2000 ms | fade of the lines an on-disk reload changed (the one long fade; reduced motion shows it without fading) |
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
  A floating card that is a plain element, not a Base UI popup (the approval card, the pick /
  send-selection panel), has no `data-starting-style`, so it gets `motion-enter`: the same fade +
  scale .98 → 1 as a keyframe, from its anchored edge (`origin-*`). It leaves at once.
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

Nothing loops for decoration: no spinners, shimmers, typing dots or skeleton sweeps. Work in
progress is text ("Thinking…", "Loading…") or the working dot; a view's `Progress` bar shows the
value it was given, with no transition and no indeterminate sweep. Scrolls jump: the chat's "scroll to latest" is
instant (use-stick-to-bottom's default is a spring), and no code asks for
`behavior: 'smooth'`. The one scroll animation is Monaco's `smoothScrolling`, which reduced
motion turns off.

Extension panels get the same tokens from `sdk/panel.css` (`base.css`), scaled by
`--pine-motion-scale` (`docs/EXTENSIONS.md`). Guard: `src/renderer/lib/motion.test.tsx` fails
on a raw duration or easing in any transition or animation (renderer and extension CSS), a
second infinite loop, and, in renderer and extension code, Tailwind `duration-*` / `ease-*` /
`delay-*`, tw-animate classes, `transition-all`, press scaling, inline transition styles and
smooth `scrollIntoView`.

Reduced motion: `appearance.motion` (Settings → Appearance → Motion) is `system` (follow
`prefers-reduced-motion`), `reduced` or `full` (ignore the OS), mirrored to `<html
data-motion>`. Reduced collapses every duration and delay to ~0 and runs loops once, so pulses
become static indicators; the dots, ring and badge still show the state. JavaScript-driven
motion reads the same decision through `useReducedMotion()` (`lib/motion.ts`): Monaco's smooth
scrolling and the extension panels' `--pine-motion-scale` follow it.

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

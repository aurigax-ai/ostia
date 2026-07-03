# Pine Design Guidelines

A portable design system for a **dense, keyboard-first desktop IDE** (terminal + editor + agent workspace). Every value is concrete and tuned for that workload. Produced by a research + dual-review pass (senior FE/UX designer + Codex) across Warp, Linear, Zed, VSCode, Postman, httpie, and cmux.

**Token tiers:** **primitive** `--color-*` (raw scale, remapped by themes, never used in components) → **semantic** alias in `:root` (`--bg`, `--surface-*`, `--fg`, `--brand`, `--attn`…) → optional **component**. Components consume the semantic layer only; themes remap `--color-*` beneath. Anything marked `NEW` doesn't exist in `index.css` yet.

---

## 1. Principles

- **Dense over roomy.** A pro tool: favor information density and 1px dividers over whitespace. VSCode-dense chrome; reserve Linear-style breathing room for settings/onboarding only.
- **Keyboard-first, mouse-second.** Every action is keyboard-reachable, shows a visible `:focus-visible` ring, and surfaces its shortcut inline. The command palette is the primary discovery surface.
- **Instant, quiet motion.** Motion communicates state change, never decorates. 0ms on the typing path; ≤180ms elsewhere; no spring/bounce/parallax.
- **Hierarchy via color + weight, not size.** A narrow type scale (11–14px) plus `--fg`/`--fg-muted` and weights 400/500/600 carry the load.
- **Instant-apply settings.** Toggles/selects mutate state immediately. Save/Cancel bars only for destructive or account forms.
- **Semantic tokens only.** Never hardcode a primitive or hex in a component.
- **State is never hue-alone.** Every status color is paired with an icon/shape/text label (colorblind + `forced-colors` safety).
- **One value per axis.** One radius per element class, one emphasis weight (500). Consistency reads as polish.

## 2. Spacing scale

Base unit **4px**. Avoid odd values (6/10/14) as first-class tokens — one-off optical corrections only.

| Token | px | Use |
|---|---|---|
| `space-1` | 4 | dense row v-padding, tightest gaps |
| `space-2` | 8 | default intra-component gap (icon↔label) |
| `space-3` | 12 | dense row padding, control padding, sidebar h-padding |
| `space-4` | 16 | default panel/section padding |
| `space-5` | 20 | card/dialog padding |
| `space-6` | 24 | separation between setting groups |
| `space-8` | 32 | major settings section blocks |

Rhythm: intra-group `space-2`; inter-group `space-4`–`space-6`; page sections `space-8`.

## 3. Type scale

Anchor primary UI at **13px** (not the 16px web default). Chrome 11–13px; content 13–14px; headings step 16 → 20 → 24 (never 13 → 24). Namespace as `text-ui-*` so stock Tailwind utilities in copied components render as authored.

| Token | px / line-height | Use |
|---|---|---|
| `text-ui-2xs` | 10 / 14 | keycaps, badges, line numbers (glyph-only) |
| `text-ui-xs` | 11 / 16 | captions, metadata, status bar, tab labels, all-caps heads |
| `text-ui-sm` | 12 / 18 | tree/list rows, tooltips, secondary UI |
| `text-ui-base` | 13 / 20 | **primary UI body** — menus, buttons, inputs, labels |
| `text-ui-emphasis` | 14 / 20 | emphasized body; markdown/preview panes |
| `text-ui-lg` | 16 / 22 | section headings, dialog titles |
| `text-ui-xl` | 20 / 26 | page/view titles |

**Weights:** `400` body/rows · `500` emphasis (active tab, selected row, button labels, section headers) · `600` headings/dialog titles. `700` only ≥20px display; `300` never.

**Dense rows** use a fixed **row height** (22px @13px, 20px @12px) with text centered — box height, not leading. Body/descriptions `1.5`; headings `1.2–1.3`; code/terminal `1.4–1.5` (user-settable).

**Mono vs sans:** sans (**Inter**, `--font-sans`) for ALL chrome — this supersedes the earlier mono-forward chrome stance. Mono only for literal machine text: Geist Mono in the editor, Hack Nerd in the terminal — code, paths, hashes, hex, ports. For changing numbers in sans UI use `font-variant-numeric: tabular-nums`, don't switch families. Do **not** apply global `-webkit-font-smoothing: antialiased` (thins Linux/macOS small text).

## 4. Color / token semantics

Radix 12-step role map → Pine tokens (role-indexed, so themes swap cleanly):

| Role | Pine token |
|---|---|
| App background | `--bg` |
| Subtle background | `--bg-sunken` |
| UI element bg (rest / hover / active) | `--surface-1` / `--surface-2` / `--surface-3` |
| Subtle border / UI border | `--line` / `--line-strong` |
| Solid accent (rest / hover) | `--brand` / `--brand-bright` |
| Low- / high-contrast text | `--fg-muted` / `--fg` |
| State | `--ok` / `--attn` (+ `--add` / `--del` for diffs) |

**Dark-first elevation** = lightness, not shadow (shadow reserved for overlays). Steps must be perceptually distinct on cheap panels (~+4/+8/+12 ΔL feel, not 3% HSL deltas). Borders are low-opacity white: `--line` `rgba(255,255,255,0.07)`, `--line-strong` `0.13`. Every status color pairs with an icon/label. Themes are plugin-contributed `--color-*` maps; give every semantic alias a fallback so partial themes degrade gracefully (VSCode model). Contrast targets: body ≥4.5:1, large/UI ≥3:1.

## 5. Components

- **Settings row:** label (+ optional description) left, control right. Row is `~py-1.5`; align `items-start` when a description wraps, else `items-center`. Group headers are `text-ui-lg` weight-600 with no sub-description; a `--line` divider separates groups (no extra padding around it).
- **Rows vs cards:** default to **rows** in dense surfaces (settings, lists, status). Cards only for genuinely separable objects (a plugin with actions), never for a plain settings list.
- **Controls:** Switch (instant-apply toggle) · Select (dropdown, trigger shows the value) · Input (text/number) · segmented only for ≤4 mutually-exclusive short options. Control height ~28px (`h-7`), matching row density.
- **Sidebar tabs:** uniform height, lead icon · title (+ meta), hover-revealed `⋮`/`×` actions. Active = `--surface-2` bg + `--brand` lead. Status via a colored dot, never hue-only.
- **Status dots/badges:** 6–8px dot in a state color + text; `--ok` running/done, `--brand` active/installed, `--fg-dim` idle/missing, `--attn` error.
- **Empty states:** one line of muted text + the primary action, never a marketing illustration.

## 6. Density & layout

- Settings content column: **~640–760px** max width with `space-6`–`space-8` horizontal padding — dense, not a web content column.
- List/tree rows: 22–28px tall. Toolbars/tab strips: 32–36px. Section vertical rhythm `space-5`–`space-6`.
- 1px `--line` dividers do the separating; don't stack padding on top of a divider.

## 7. Interaction & a11y

- **Focus:** visible `:focus-visible` ring (`--brand`/`--brand-bright`) on every interactive DOM element. Move focus into a surface when it opens; restore it on close. Canvas surfaces (xterm/Monaco) manage their own focus.
- **Keyboard nav:** roving tabindex + Up/Down/Home/End in list/section navs; Enter/Space to activate; Escape to dismiss/deselect. Label every control (`aria-label` or associated label) — adjacent text is not enough.
- **Motion:** 120–180ms ease for hovers/expands; 0ms on the typing path; honor `prefers-reduced-motion`. Narrow `transition` to the properties that change (never `transition-all`).
- **Overlays:** when a surface covers others, mark the covered subtree `inert` + `aria-hidden` so focus can't leak.

## 8. Live-surface (xterm/Monaco) rules — from the cmux study

These are correctness rules for the canvas surfaces, learned from cmux/wmux:

- **Mount once, keep alive.** Never unmount a terminal/session on tab switch — flip CSS visibility instead. Preserves ptys + scrollback + splitter proportions.
- **Prefer `visibility:hidden` (+ absolute stacking) over `display:none`** for hidden sessions: the box keeps its size, so FitAddon stays correct and no re-fit is needed on switch. If you must use `display:none`, re-fit inside `requestAnimationFrame` on the hidden→visible transition.
- **Never fit a 0-sized element** — FitAddon computes 0 cols/rows and corrupts the pty buffer ("infinite duplication"). Guard every `fit()` with `offsetWidth/Height > 0`.
- **Never forward a 0×0 or unchanged size to the pty.** Dedupe with the last-sent cols/rows.
- **One debounced ResizeObserver per terminal, wrapped in rAF.** Handles container resize + splitter drag uniformly.
- **Keep the Allotment tree shape stable, key panes by stable id.** Adding/removing a pane must not remount survivors — that preserves xterm state and measured proportions.

## 9. Library vs hand-roll policy (shadcn/Base UI)

Reach for **shadcn/Base UI** whenever the control has a non-trivial interaction contract — focus management, keyboard nav, portal/z-index, or a11y semantics the browser doesn't give for free (buttons, inputs, selects, switches, tooltips, dialogs, menus, comboboxes). Skin them with Pine's semantic tokens (already bridged in `index.css`); never fork a second implementation of the same role.

**Hand-roll only** when the surface is fundamentally not a form control — a live canvas (xterm/Monaco), a measured/animated overlay (`Blocks.tsx`), bespoke data-viz with no library equivalent (`UsageMeter`), or a dense product-specific composite row (rail tab, pane header). When hand-rolling, build **one** shared component per role and reuse it — never let the same role grow a second slightly-different implementation in another file. Every hand-rolled interactive element still gets its tooltip via `Hint` (never native `title=`) and its type/spacing from the shared scale (never a raw px value).

**Known consolidation debt (audited 2026-07-01):** (a) four forked icon-buttons — `.topbar-btn` / `.iconbtn` / `.tab-btn` / `.rail-switch-btn` — should collapse to one `IconButton` (or shadcn `Button size="icon-*"`); (b) shadcn `Button` has **zero** adoption — every clickable is a raw `<button>`; (c) `title=` still leaks in `TopBar` (command-center) + `Inspector` (close) instead of `Hint`; (d) the `text-ui-*` scale in §3 is not yet implemented (components free-hand `text-[Npx]`); (e) two radius ladders coexist (Pine `--radius-sm` 5px vs the shadcn-bridge 4.8/6.4/8/11.2). Missing primitives to add: `DropdownMenu` (tab ⋮ / pane menu), `ContextMenu` (pane + file-tree right-click), `Popover` (inline rename).

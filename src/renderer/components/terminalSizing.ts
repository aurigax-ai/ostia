/**
 * Pure sizing/attach decision for a terminal surface, factored out of `Terminal.tsx` so it can
 * be unit-tested without rendering xterm (which needs a real canvas/layout — E2E territory).
 *
 * The rule it encodes fixes the "staircase of prompts" bug: the pty must be spawned at the REAL
 * fitted size, never xterm's 80×24 default. If we attached at the default and then grew to the
 * real box, the shell's first prompt (and its right-aligned RPROMPT clock) would be drawn at the
 * wrong width and stranded by xterm's reflow — stacking a fresh prompt line per intermediate
 * size. So: don't attach until the host has a real layout box (`fitted` — `FitAddon.fit()` ran)
 * AND a valid non-zero size; the first such fit spawns the pty, later ones only resize it, and an
 * unchanged size is a no-op (no redundant SIGWINCH → no redraw).
 */

/** What the caller should do with the pty for the current fit result. */
export type SizeAction =
  | { type: 'none' }
  | { type: 'attach'; cols: number; rows: number }
  | { type: 'resize'; cols: number; rows: number }

/** Inputs are all plain values so this is trivially testable and has zero xterm/DOM coupling. */
export interface SizeDecisionInput {
  /** Did `safeFit` actually fit (host had a non-zero box)? A 0×0 host must NOT drive the pty. */
  fitted: boolean
  /** Has the pty already been attached/spawned? First valid fit flips this. */
  attached: boolean
  /** Current terminal columns (xterm reports 80 by default before a real fit). */
  cols: number
  /** Current terminal rows (24 by default before a real fit). */
  rows: number
  /** Last size forwarded to the pty, to suppress redundant resizes. */
  last: { cols: number; rows: number }
}

/**
 * Decide the pty action for the current fit. Never returns `attach`/`resize` for a 0×0 host or a
 * non-positive size (would corrupt the pty buffer — the cmux "infinite duplication" bug), never
 * `resize` for an unchanged size (avoids a needless SIGWINCH prompt redraw), and yields exactly
 * one `attach` — spawning the pty at the real fitted size — before any `resize`.
 */
export function nextSizeAction({
  fitted,
  attached,
  cols,
  rows,
  last,
}: SizeDecisionInput): SizeAction {
  if (!fitted) return { type: 'none' } // host has no layout box yet — wait for the ResizeObserver
  if (cols <= 0 || rows <= 0) return { type: 'none' }
  if (!attached) return { type: 'attach', cols, rows } // spawn at the REAL size, not 80×24
  if (cols !== last.cols || rows !== last.rows) return { type: 'resize', cols, rows }
  return { type: 'none' } // unchanged — don't make the shell redraw its prompt
}

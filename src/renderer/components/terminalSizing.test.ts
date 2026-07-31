import { describe, expect, it } from 'vitest'
import { nextSizeAction } from './terminalSizing'

/**
 * These lock in the fix for the "staircase of prompts" bug: the pty must spawn at the REAL fitted
 * size, never xterm's 80×24 default. The failure mode was attaching before the portal slot had a
 * layout box (host 0×0 → `FitAddon.fit()` bails → term still reports 80×24), spawning the shell
 * narrow, then growing — which strands/stacks the prompt via xterm reflow.
 */
describe('nextSizeAction', () => {
  const last0 = { cols: 0, rows: 0 }

  it('does NOTHING while the host has no layout box (fitted=false) — never attaches at 80×24', () => {
    // The regression: xterm reports its 80×24 default before a real fit. Attaching here is the
    // bug. A 0×0 host must not spawn the pty — the ResizeObserver retries once the box appears.
    expect(
      nextSizeAction({ fitted: false, attached: false, cols: 80, rows: 24, last: last0 }),
    ).toEqual({ type: 'none' })
  })

  it('attaches at the real fitted size on the first valid fit (not the 80×24 default)', () => {
    expect(
      nextSizeAction({ fitted: true, attached: false, cols: 152, rows: 40, last: last0 }),
    ).toEqual({ type: 'attach', cols: 152, rows: 40 })
  })

  it('models the staircase race end-to-end: 0×0 fit no-ops, then attaches at the grown size', () => {
    // Frame 1: slot not laid out yet.
    expect(
      nextSizeAction({ fitted: false, attached: false, cols: 80, rows: 24, last: last0 }),
    ).toEqual({ type: 'none' })
    // Frame 2: box appears at the real width → spawn there directly. No intermediate 80-col spawn,
    // so the shell's first prompt is drawn once, at the right width — no stranded RPROMPT.
    expect(
      nextSizeAction({ fitted: true, attached: false, cols: 152, rows: 40, last: last0 }),
    ).toEqual({ type: 'attach', cols: 152, rows: 40 })
  })

  it('never attaches/resizes on a non-positive size even if fitted (0-size guard)', () => {
    expect(
      nextSizeAction({ fitted: true, attached: false, cols: 0, rows: 40, last: last0 }),
    ).toEqual({ type: 'none' })
    expect(
      nextSizeAction({ fitted: true, attached: true, cols: 152, rows: 0, last: last0 }),
    ).toEqual({ type: 'none' })
  })

  it('resizes an attached pty only when the size actually changed', () => {
    const last = { cols: 152, rows: 40 }
    // Unchanged → no SIGWINCH (would make the shell redraw its prompt for nothing).
    expect(nextSizeAction({ fitted: true, attached: true, cols: 152, rows: 40, last })).toEqual({
      type: 'none',
    })
    // Changed → forward the new size.
    expect(nextSizeAction({ fitted: true, attached: true, cols: 120, rows: 30, last })).toEqual({
      type: 'resize',
      cols: 120,
      rows: 30,
    })
  })
})

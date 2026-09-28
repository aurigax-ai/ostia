import { describe, expect, it } from 'vitest'
import { nextSizeAction } from './terminalSizing'

describe('nextSizeAction', () => {
  const last0 = { cols: 0, rows: 0 }

  it('does NOTHING while the host has no layout box (fitted=false) — never attaches at 80×24', () => {
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
    expect(
      nextSizeAction({ fitted: false, attached: false, cols: 80, rows: 24, last: last0 }),
    ).toEqual({ type: 'none' })
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
    expect(nextSizeAction({ fitted: true, attached: true, cols: 152, rows: 40, last })).toEqual({
      type: 'none',
    })
    expect(nextSizeAction({ fitted: true, attached: true, cols: 120, rows: 30, last })).toEqual({
      type: 'resize',
      cols: 120,
      rows: 30,
    })
  })
})

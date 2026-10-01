import { describe, expect, it } from 'vitest'
import { MAX_FIT_PASSES, isPromptRepaint, nextSizeAction, settleFit } from './terminalSizing'

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

describe('isPromptRepaint', () => {
  it('treats held bytes as a prompt repaint unless a command started while holding', () => {
    expect(isPromptRepaint('\x1b]133;A\x1b\\% ls')).toBe(true)
    expect(isPromptRepaint('\r\n\x1b]133;C\x1b\\file.txt\r\n')).toBe(false)
  })
})

describe('settleFit', () => {
  const domCellWidth = (charWidth: number, cols: number): number =>
    Math.round(charWidth * cols) / cols

  const domFitter = (available: number, charWidth: number, start: number) => {
    let cols = start
    const fits: number[] = []
    const fitOnce = () => {
      cols = Math.floor(available / domCellWidth(charWidth, cols))
      fits.push(cols)
      return { cols, rows: 91 }
    }
    return { fitOnce, fits }
  }

  it('fits again until the size stops changing when the cell width depends on the column count', () => {
    const { fitOnce, fits } = domFitter(746, 4.81640625, 80)
    expect(settleFit(fitOnce)).toEqual({ cols: 154, rows: 91 })
    expect(fits).toEqual([155, 154, 154])
  })

  it('returns after two passes when the first fit is already stable', () => {
    let calls = 0
    const size = settleFit(() => {
      calls++
      return { cols: 150, rows: 82 }
    })
    expect(size).toEqual({ cols: 150, rows: 82 })
    expect(calls).toBe(2)
  })

  it('stops after the pass limit when the fit oscillates', () => {
    let calls = 0
    const size = settleFit(() => {
      calls++
      return { cols: calls % 2 ? 100 : 101, rows: 40 }
    })
    expect(calls).toBe(MAX_FIT_PASSES)
    expect(size).toEqual({ cols: 101, rows: 40 })
  })

  it('returns null when the host cannot be measured on the first pass', () => {
    expect(settleFit(() => null)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import {
  MIN_INPUT_COLS,
  cellBox,
  placePrompt,
  rightPromptStart,
  rowsToMake,
  scrollUpSequence,
} from './promptOverlay'

const base = {
  inputLine: 110,
  inputCol: 14,
  viewportY: 100,
  rows: 24,
  cols: 80,
  rightPromptCol: null,
  style: 'shell' as const,
  sameLine: false,
}

describe('placePrompt', () => {
  it('starts the editor at the shell input column so the shell’s own prompt stays visible', () => {
    expect(placePrompt(base)).toEqual({
      row: 10,
      col: 14,
      endCol: 80,
      chipsRow: null,
      rowsBelow: 13,
    })
  })

  it('stops before a right prompt when there is room, and covers it when there is not', () => {
    expect(placePrompt({ ...base, rightPromptCol: 60 })?.endCol).toBe(60)
    expect(placePrompt({ ...base, rightPromptCol: 14 + MIN_INPUT_COLS - 1 })?.endCol).toBe(80)
  })

  it('puts the Pine prompt chips on the row above and keeps the shell separator before the input', () => {
    expect(placePrompt({ ...base, style: 'pine', inputCol: 2 })).toMatchObject({
      col: 2,
      endCol: 80,
      chipsRow: 9,
    })
  })

  it('covers the whole row for a same-line Pine prompt, which draws its own separator', () => {
    expect(placePrompt({ ...base, style: 'pine', sameLine: true })).toMatchObject({
      col: 0,
      endCol: 80,
      chipsRow: null,
    })
    expect(placePrompt({ ...base, style: 'pine', inputLine: 100 })?.chipsRow).toBeNull()
  })

  it('returns null when the input line is scrolled out of view', () => {
    expect(placePrompt({ ...base, viewportY: 111 })).toBeNull()
    expect(placePrompt({ ...base, viewportY: 80 })).toBeNull()
    expect(placePrompt({ ...base, rows: 0 })).toBeNull()
  })

  it('reports the free rows under the input line', () => {
    expect(placePrompt({ ...base, inputLine: 123 })?.rowsBelow).toBe(0)
  })
})

describe('rightPromptStart', () => {
  it('finds the first drawn cell after the input column', () => {
    const cells = ['~', ' ', '❯', ' ', '', '', ' ', 'm', 'a', 'i', 'n']
    expect(rightPromptStart(cells, 4)).toBe(7)
    expect(rightPromptStart(cells, 0)).toBe(0)
    expect(rightPromptStart(['a', ' ', ''], 1)).toBeNull()
  })
})

describe('cellBox', () => {
  it('maps a row and column range to pixels from the grid origin', () => {
    expect(cellBox({ width: 8, height: 17, left: 6, top: 4 }, 3, 2, 10)).toEqual({
      left: 22,
      top: 55,
      width: 64,
      height: 17,
    })
  })
})

describe('rowsToMake', () => {
  it('asks for rows only when the draft is taller than the space under the prompt', () => {
    expect(rowsToMake(1, 0, 8)).toBe(0)
    expect(rowsToMake(3, 0, 8)).toBe(2)
    expect(rowsToMake(3, 5, 8)).toBe(0)
    expect(rowsToMake(20, 0, 8)).toBe(7)
  })
})

describe('scrollUpSequence', () => {
  it('scrolls from the bottom row and puts the cursor back on the moved prompt', () => {
    expect(scrollUpSequence(24, 23, 14, 2)).toBe('\x1b[24;1H\n\n\x1b[22;15H')
    expect(scrollUpSequence(24, 23, 14, 0)).toBe('')
  })
})

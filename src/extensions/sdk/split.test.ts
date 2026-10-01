import { describe, expect, it } from 'vitest'
import {
  MAX_PANEL_SIZES,
  SPLIT_KEY_STEP,
  SPLIT_PAGE_STEP,
  clampPosition,
  fractionOf,
  keyPosition,
  parsePanelSizes,
  percentOf,
  splitBounds,
  withPanelSize,
} from './split'

describe('splitBounds', () => {
  it('keeps both minimums when the panel has room for them', () => {
    expect(splitBounds(500, 96, 120)).toEqual({ min: 96, max: 380, collapsed: false })
  })

  it('reports collapsed when the panel is shorter than both minimums', () => {
    const bounds = splitBounds(150, 96, 96)
    expect(bounds.collapsed).toBe(true)
    expect(bounds.min).toBeLessThanOrEqual(bounds.max)
  })
})

describe('clampPosition', () => {
  it('holds the divider between the two minimums', () => {
    const bounds = splitBounds(400, 100, 100)
    expect(clampPosition(20, bounds)).toBe(100)
    expect(clampPosition(390, bounds)).toBe(300)
    expect(clampPosition(250, bounds)).toBe(250)
  })
})

describe('fractionOf', () => {
  it('stores a clamped fraction of the panel height', () => {
    const bounds = splitBounds(400, 100, 100)
    expect(fractionOf(200, 400, bounds)).toBe(0.5)
    expect(fractionOf(399, 400, bounds)).toBe(0.75)
  })

  it('stores zero for a panel with no height', () => {
    expect(fractionOf(50, 0, splitBounds(0, 10, 10))).toBe(0)
  })
})

describe('keyPosition', () => {
  const bounds = splitBounds(600, 96, 96)

  it('moves by a small step on arrows and a larger one on page keys', () => {
    expect(keyPosition('ArrowUp', 300, bounds)).toBe(300 - SPLIT_KEY_STEP)
    expect(keyPosition('ArrowDown', 300, bounds)).toBe(300 + SPLIT_KEY_STEP)
    expect(keyPosition('PageUp', 300, bounds)).toBe(300 - SPLIT_PAGE_STEP)
    expect(keyPosition('PageDown', 300, bounds)).toBe(300 + SPLIT_PAGE_STEP)
  })

  it('jumps to the minimum and maximum on Home and End', () => {
    expect(keyPosition('Home', 300, bounds)).toBe(96)
    expect(keyPosition('End', 300, bounds)).toBe(504)
  })

  it('never steps past the minimums', () => {
    expect(keyPosition('ArrowUp', 100, bounds)).toBe(96)
    expect(keyPosition('PageDown', 500, bounds)).toBe(504)
  })

  it('ignores keys that do not move the divider', () => {
    expect(keyPosition('Enter', 300, bounds)).toBeNull()
  })
})

describe('percentOf', () => {
  it('rounds the divider position to a percentage for aria-valuenow', () => {
    expect(percentOf(133, 400)).toBe(33)
    expect(percentOf(10, 0)).toBe(0)
  })
})

describe('parsePanelSizes', () => {
  it('keeps fractions under valid keys and drops everything else', () => {
    expect(
      parsePanelSizes({
        'graph-details': 0.4,
        'changes.commit': 0,
        big: 1.5,
        negative: -0.1,
        word: 'half',
        'bad key': 0.5,
        '-dash': 0.5,
      }),
    ).toEqual({ 'graph-details': 0.4, 'changes.commit': 0 })
  })

  it('starts empty for anything that is not an object', () => {
    expect(parsePanelSizes(null)).toEqual({})
    expect(parsePanelSizes([0.5])).toEqual({})
  })

  it('keeps only the newest sizes past the cap', () => {
    let sizes: Record<string, number> = {}
    for (let i = 0; i <= MAX_PANEL_SIZES; i++) sizes = withPanelSize(sizes, `k${i}`, 0.5)
    expect(Object.keys(sizes)).toHaveLength(MAX_PANEL_SIZES)
    expect(sizes).not.toHaveProperty('k0')
    expect(sizes[`k${MAX_PANEL_SIZES}`]).toBe(0.5)
  })
})

describe('withPanelSize', () => {
  it('sets, replaces and forgets a size', () => {
    const set = withPanelSize({}, 'a', 0.3)
    expect(withPanelSize(set, 'a', 0.6)).toEqual({ a: 0.6 })
    expect(withPanelSize(set, 'a', null)).toEqual({})
  })
})

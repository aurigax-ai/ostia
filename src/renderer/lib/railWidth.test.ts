import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installLocalStorage } from '../../../test/mocks/memoryStorage'
import {
  RAIL_COLLAPSE_BELOW,
  RAIL_DEFAULT_WIDTH,
  RAIL_KEY_STEP,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  RAIL_WIDTH_KEY,
  applyStoredRailWidth,
  clampRailWidth,
  railDragResult,
  railKeyWidth,
  railMaxWidth,
  storeRailWidth,
  storedRailWidth,
} from './railWidth'

const WIDE = 1600

describe('railMaxWidth', () => {
  it('caps the rail at the fixed maximum on a wide window', () => {
    expect(railMaxWidth(WIDE)).toBe(RAIL_MAX_WIDTH)
  })

  it('caps the rail at 40% of a narrower window', () => {
    expect(railMaxWidth(1000)).toBe(400)
  })

  it('never drops below the minimum on a tiny window', () => {
    expect(railMaxWidth(300)).toBe(RAIL_MIN_WIDTH)
  })
})

describe('clampRailWidth', () => {
  it('keeps a width inside the range as a whole pixel', () => {
    expect(clampRailWidth(300.4, WIDE)).toBe(300)
  })

  it('raises a width below the minimum to the minimum', () => {
    expect(clampRailWidth(120, WIDE)).toBe(RAIL_MIN_WIDTH)
  })

  it('lowers a width above the window cap to the cap', () => {
    expect(clampRailWidth(470, 1000)).toBe(400)
  })
})

describe('railDragResult', () => {
  it('follows the pointer within the range', () => {
    expect(railDragResult(240, 60, WIDE)).toEqual({ collapsed: false, width: 300 })
  })

  it('clamps at the minimum while the pointer is between the snap point and the minimum', () => {
    expect(railDragResult(240, RAIL_COLLAPSE_BELOW - 240, WIDE)).toEqual({
      collapsed: false,
      width: RAIL_MIN_WIDTH,
    })
  })

  it('snaps to collapsed below the snap point and keeps the width the drag started from', () => {
    expect(railDragResult(300, RAIL_COLLAPSE_BELOW - 301, WIDE)).toEqual({
      collapsed: true,
      width: 300,
    })
  })

  it('clamps at the maximum when dragged past it', () => {
    expect(railDragResult(240, 900, WIDE)).toEqual({ collapsed: false, width: RAIL_MAX_WIDTH })
  })
})

describe('railKeyWidth', () => {
  it('moves the edge by one step with the arrow keys', () => {
    expect(railKeyWidth('ArrowRight', 240, WIDE)).toBe(240 + RAIL_KEY_STEP)
    expect(railKeyWidth('ArrowLeft', 240, WIDE)).toBe(240 - RAIL_KEY_STEP)
  })

  it('stops the arrow keys at the range ends', () => {
    expect(railKeyWidth('ArrowLeft', RAIL_MIN_WIDTH, WIDE)).toBe(RAIL_MIN_WIDTH)
    expect(railKeyWidth('ArrowRight', 400, 1000)).toBe(400)
  })

  it('jumps to the minimum on Home and the maximum on End', () => {
    expect(railKeyWidth('Home', 300, WIDE)).toBe(RAIL_MIN_WIDTH)
    expect(railKeyWidth('End', 300, 1000)).toBe(400)
  })

  it('ignores other keys', () => {
    expect(railKeyWidth('ArrowUp', 300, WIDE)).toBeNull()
    expect(railKeyWidth('Enter', 300, WIDE)).toBeNull()
  })
})

describe('stored rail width', () => {
  beforeEach(() => {
    installLocalStorage()
  })

  afterEach(() => {
    window.localStorage.clear()
    document.documentElement.style.removeProperty('--rail-w')
  })

  it('starts at the default when nothing is stored', () => {
    expect(storedRailWidth()).toBe(RAIL_DEFAULT_WIDTH)
  })

  it('reads back a stored width', () => {
    storeRailWidth(320)
    expect(window.localStorage.getItem(RAIL_WIDTH_KEY)).toBe('320')
    expect(storedRailWidth()).toBe(320)
  })

  it('falls back to the default for a width out of range or not a number', () => {
    window.localStorage.setItem(RAIL_WIDTH_KEY, '9000')
    expect(storedRailWidth()).toBe(RAIL_DEFAULT_WIDTH)
    window.localStorage.setItem(RAIL_WIDTH_KEY, '"wide"')
    expect(storedRailWidth()).toBe(RAIL_DEFAULT_WIDTH)
    window.localStorage.setItem(RAIL_WIDTH_KEY, '{')
    expect(storedRailWidth()).toBe(RAIL_DEFAULT_WIDTH)
  })

  it('applies the stored width to the rail before the app renders, capped by the window', () => {
    storeRailWidth(320)
    applyStoredRailWidth()
    expect(document.documentElement.style.getPropertyValue('--rail-w')).toBe(
      `${clampRailWidth(320, window.innerWidth)}px`,
    )
  })
})

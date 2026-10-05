import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installLocalStorage } from '../../../test/mocks/memoryStorage'
import {
  FILES_WIDTH,
  PANEL_KEY_STEP,
  RAIL_WIDTH,
  applyStoredPanelWidths,
  clampPanelWidth,
  panelDragResult,
  panelKeyWidth,
  panelMaxWidth,
  storePanelWidth,
  storedPanelWidth,
} from './panelWidth'

const WIDE = 1600
const COLLAPSE_BELOW = RAIL_WIDTH.collapseBelow ?? 0

describe('panelMaxWidth', () => {
  it('caps the rail at the fixed maximum on a wide window', () => {
    expect(panelMaxWidth(RAIL_WIDTH, WIDE)).toBe(RAIL_WIDTH.maxWidth)
  })

  it('caps the rail at 40% of a narrower window', () => {
    expect(panelMaxWidth(RAIL_WIDTH, 1000)).toBe(400)
  })

  it('never drops below the minimum on a tiny window', () => {
    expect(panelMaxWidth(RAIL_WIDTH, 300)).toBe(RAIL_WIDTH.minWidth)
  })
})

describe('clampPanelWidth', () => {
  it('keeps a width inside the range as a whole pixel', () => {
    expect(clampPanelWidth(RAIL_WIDTH, 300.4, WIDE)).toBe(300)
  })

  it('raises a width below the minimum to the minimum', () => {
    expect(clampPanelWidth(RAIL_WIDTH, 120, WIDE)).toBe(RAIL_WIDTH.minWidth)
  })

  it('lowers a width above the window cap to the cap', () => {
    expect(clampPanelWidth(RAIL_WIDTH, 470, 1000)).toBe(400)
  })
})

describe('panelDragResult', () => {
  it('follows the pointer within the range', () => {
    expect(panelDragResult(RAIL_WIDTH, 240, 60, WIDE)).toEqual({ collapsed: false, width: 300 })
  })

  it('clamps at the minimum while the pointer is between the snap point and the minimum', () => {
    expect(panelDragResult(RAIL_WIDTH, 240, COLLAPSE_BELOW - 240, WIDE)).toEqual({
      collapsed: false,
      width: RAIL_WIDTH.minWidth,
    })
  })

  it('snaps to collapsed below the snap point and keeps the width the drag started from', () => {
    expect(panelDragResult(RAIL_WIDTH, 300, COLLAPSE_BELOW - 301, WIDE)).toEqual({
      collapsed: true,
      width: 300,
    })
  })

  it('clamps at the maximum when dragged past it', () => {
    expect(panelDragResult(RAIL_WIDTH, 240, 900, WIDE)).toEqual({
      collapsed: false,
      width: RAIL_WIDTH.maxWidth,
    })
  })
})

describe('panelKeyWidth', () => {
  it('moves the edge by one step with the arrow keys', () => {
    expect(panelKeyWidth(RAIL_WIDTH, 'ArrowRight', 240, WIDE)).toBe(240 + PANEL_KEY_STEP)
    expect(panelKeyWidth(RAIL_WIDTH, 'ArrowLeft', 240, WIDE)).toBe(240 - PANEL_KEY_STEP)
  })

  it('stops the arrow keys at the range ends', () => {
    expect(panelKeyWidth(RAIL_WIDTH, 'ArrowLeft', RAIL_WIDTH.minWidth, WIDE)).toBe(
      RAIL_WIDTH.minWidth,
    )
    expect(panelKeyWidth(RAIL_WIDTH, 'ArrowRight', 400, 1000)).toBe(400)
  })

  it('jumps to the minimum on Home and the maximum on End', () => {
    expect(panelKeyWidth(RAIL_WIDTH, 'Home', 300, WIDE)).toBe(RAIL_WIDTH.minWidth)
    expect(panelKeyWidth(RAIL_WIDTH, 'End', 300, 1000)).toBe(400)
  })

  it('ignores other keys', () => {
    expect(panelKeyWidth(RAIL_WIDTH, 'ArrowUp', 300, WIDE)).toBeNull()
    expect(panelKeyWidth(RAIL_WIDTH, 'Enter', 300, WIDE)).toBeNull()
  })
})

describe('stored rail width', () => {
  beforeEach(() => {
    installLocalStorage()
  })

  afterEach(() => {
    window.localStorage.clear()
    document.documentElement.style.removeProperty('--rail-w')
    document.documentElement.style.removeProperty('--files-w')
  })

  it('starts at the default when nothing is stored', () => {
    expect(storedPanelWidth(RAIL_WIDTH)).toBe(RAIL_WIDTH.defaultWidth)
  })

  it('reads back a stored width', () => {
    storePanelWidth(RAIL_WIDTH, 320)
    expect(window.localStorage.getItem(RAIL_WIDTH.storageKey)).toBe('320')
    expect(storedPanelWidth(RAIL_WIDTH)).toBe(320)
  })

  it('falls back to the default for a width out of range or not a number', () => {
    window.localStorage.setItem(RAIL_WIDTH.storageKey, '9000')
    expect(storedPanelWidth(RAIL_WIDTH)).toBe(RAIL_WIDTH.defaultWidth)
    window.localStorage.setItem(RAIL_WIDTH.storageKey, '"wide"')
    expect(storedPanelWidth(RAIL_WIDTH)).toBe(RAIL_WIDTH.defaultWidth)
    window.localStorage.setItem(RAIL_WIDTH.storageKey, '{')
    expect(storedPanelWidth(RAIL_WIDTH)).toBe(RAIL_WIDTH.defaultWidth)
  })

  it('applies the stored widths to the rail and Files before the app renders, capped by the window', () => {
    storePanelWidth(RAIL_WIDTH, 320)
    storePanelWidth(FILES_WIDTH, 600)
    applyStoredPanelWidths()
    expect(document.documentElement.style.getPropertyValue('--rail-w')).toBe(
      `${clampPanelWidth(RAIL_WIDTH, 320, window.innerWidth)}px`,
    )
    expect(document.documentElement.style.getPropertyValue('--files-w')).toBe(
      `${clampPanelWidth(FILES_WIDTH, 600, window.innerWidth)}px`,
    )
  })
})

describe('Files panel width', () => {
  const files = FILES_WIDTH

  beforeEach(() => {
    installLocalStorage()
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  it('widens past the rail maximum on a wide window, up to half of it', () => {
    expect(panelMaxWidth(files, WIDE)).toBe(files.maxWidth)
    expect(files.maxWidth).toBeGreaterThan(RAIL_WIDTH.maxWidth)
    expect(panelMaxWidth(files, 1000)).toBe(500)
  })

  it('clamps at the minimum when dragged far left instead of collapsing', () => {
    expect(panelDragResult(files, 260, -250, WIDE)).toEqual({
      collapsed: false,
      width: files.minWidth,
    })
  })

  it('follows a drag to the right', () => {
    expect(panelDragResult(files, 260, 200, WIDE)).toEqual({ collapsed: false, width: 460 })
  })

  it('stores its width apart from the rail', () => {
    storePanelWidth(files, 500)
    expect(storedPanelWidth(files)).toBe(500)
    expect(storedPanelWidth(RAIL_WIDTH)).toBe(RAIL_WIDTH.defaultWidth)
  })
})

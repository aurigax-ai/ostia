import { describe, expect, it } from 'vitest'
import { attachWheelReports, createWheelRows, type WheelTerminal, wheelRoute } from './wheelReports'

const CELL = 17
const scale = { cellHeight: CELL, sensitivity: 1, maxRows: 40, notches: false }
const linux = { ...scale, notches: true }

type TrackingMode = WheelTerminal['modes']['mouseTrackingMode']

function fakeTerminal(state: {
  mode: TrackingMode
  buffer: 'normal' | 'alternate'
  cellHeight?: number
  sensitivity?: number
  notches?: boolean
}) {
  const element = document.createElement('div')
  const handled: WheelEvent[] = []
  let handler: (e: WheelEvent) => boolean = () => true
  element.addEventListener('wheel', (e) => {
    if (handler(e)) handled.push(e)
  })
  const term = {
    element,
    rows: 24,
    options: { scrollSensitivity: state.sensitivity ?? 1 },
    get modes() {
      return { mouseTrackingMode: state.mode }
    },
    get buffer() {
      return { active: { type: state.buffer } }
    },
    attachCustomWheelEventHandler: (h: (e: WheelEvent) => boolean) => {
      handler = h
    },
  } as unknown as WheelTerminal
  attachWheelReports(term, () => state.cellHeight ?? CELL, state.notches ?? false)
  const wheel = (deltaY: number, init: WheelEventInit = {}): WheelEvent => {
    const e = new WheelEvent('wheel', {
      deltaY,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      clientX: 120,
      clientY: 64,
      bubbles: true,
      cancelable: true,
      ...init,
    })
    element.dispatchEvent(e)
    return e
  }
  const ticks = () => handled.filter((e) => e.deltaMode === WheelEvent.DOM_DELTA_LINE)
  return { handled, ticks, wheel }
}

describe('createWheelRows', () => {
  it('turns pixel travel into one row per cell height and keeps the remainder', () => {
    const rows = createWheelRows()
    expect([5, 5, 5, 5].map((d) => rows.take(d, scale))).toEqual([0, 0, 0, 1])
    expect(rows.take(15, scale)).toBe(1)
  })

  it('counts every row of a large delta instead of one per event', () => {
    expect(createWheelRows().take(120, scale)).toBe(7)
    expect(createWheelRows().take(-120, scale)).toBe(-7)
  })

  it('scales by the scroll speed setting and caps at the terminal height', () => {
    expect(createWheelRows().take(34, { ...scale, sensitivity: 2 })).toBe(4)
    expect(createWheelRows().take(10_000, { ...scale, maxRows: 24 })).toBe(24)
    expect(createWheelRows().take(-10_000, { ...scale, maxRows: 24 })).toBe(-24)
  })

  it('drops the leftover of the old direction when the scroll reverses', () => {
    const rows = createWheelRows()
    expect(rows.take(10, scale)).toBe(0)
    expect(rows.take(-10, scale)).toBe(0)
    expect(rows.take(-10, scale)).toBe(-1)
  })

  it('sends one row for one Linux wheel notch', () => {
    expect(createWheelRows().take(120, linux)).toBe(1)
    expect(createWheelRows().take(-120, linux)).toBe(-1)
  })

  it('sends a row for every notch a Linux wheel event carries, up to the terminal height', () => {
    expect(createWheelRows().take(360, linux)).toBe(3)
    expect(createWheelRows().take(-1080, linux)).toBe(-9)
    expect(createWheelRows().take(10_000, { ...linux, maxRows: 24 })).toBe(24)
    expect(createWheelRows().take(-10_000, { ...linux, maxRows: 24 })).toBe(-24)
  })

  it('doubles the rows of a Linux wheel event at scroll speed 2', () => {
    const fast = { ...linux, sensitivity: 2 }
    expect(createWheelRows().take(120, fast)).toBe(2)
    expect(createWheelRows().take(360, fast)).toBe(6)
    const slow = createWheelRows()
    expect([120, 120].map((d) => slow.take(d, { ...linux, sensitivity: 0.5 }))).toEqual([0, 1])
  })

  it('adds fractions of a Linux wheel notch up to the same total as whole notches', () => {
    const rows = createWheelRows()
    expect(Array.from({ length: 8 }, () => rows.take(15, linux))).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    const spin = createWheelRows()
    const total = Array.from({ length: 24 }, () => spin.take(-15, linux)).reduce((a, b) => a + b, 0)
    expect(total).toBe(createWheelRows().take(-360, linux))
    const thirds = createWheelRows()
    expect([40, 40, 40, 40, 40, 40].map((d) => thirds.take(d, linux))).toEqual([0, 0, 1, 0, 0, 1])
  })

  it('carries the rest of a Linux wheel event to the next one in the same direction', () => {
    const rows = createWheelRows()
    expect(rows.take(180, linux)).toBe(1)
    expect(rows.take(60, linux)).toBe(1)
    expect(rows.take(60, linux)).toBe(0)
  })

  it('drops the rest of a Linux wheel notch when the wheel turns back', () => {
    const rows = createWheelRows()
    expect(rows.take(105, linux)).toBe(0)
    expect(rows.take(-15, linux)).toBe(0)
    expect(rows.take(-105, linux)).toBe(-1)
  })

  it('counts Linux wheel notches whatever the cell height is', () => {
    expect(createWheelRows().take(240, { ...linux, cellHeight: 0 })).toBe(2)
    expect(createWheelRows().take(240, { ...linux, cellHeight: 40 })).toBe(2)
  })

  it('does nothing without a measured cell', () => {
    expect(createWheelRows().take(120, { ...scale, cellHeight: 0 })).toBe(0)
  })
})

describe('wheelRoute', () => {
  it('reports wheel to programs that track the mouse with wheel events', () => {
    expect(wheelRoute('vt200', 'alternate')).toBe('report')
    expect(wheelRoute('drag', 'normal')).toBe('report')
    expect(wheelRoute('any', 'alternate')).toBe('report')
  })

  it('sends arrows on the alternate screen when the program does not take wheel events', () => {
    expect(wheelRoute('none', 'alternate')).toBe('arrows')
    expect(wheelRoute('x10', 'alternate')).toBe('arrows')
  })

  it('leaves the normal screen to scrollback', () => {
    expect(wheelRoute('none', 'normal')).toBeNull()
    expect(wheelRoute('x10', 'normal')).toBeNull()
  })
})

describe('attachWheelReports', () => {
  it('sends one wheel tick per row of travel to a program tracking the mouse', () => {
    const t = fakeTerminal({ mode: 'any', buffer: 'alternate' })
    const event = t.wheel(51, { altKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(t.handled).not.toContain(event)
    const ticks = t.ticks()
    expect(ticks).toHaveLength(3)
    for (const tick of ticks) {
      expect(tick.deltaY).toBe(1)
      expect(tick.clientX).toBe(120)
      expect(tick.clientY).toBe(64)
      expect(tick.altKey).toBe(true)
      expect(tick.shiftKey).toBe(false)
    }
    t.wheel(-34)
    const back = t.ticks().slice(3)
    expect(back.map((e) => e.deltaY)).toEqual([-1, -1])
  })

  it('keeps a slow trackpad stream moving instead of damping it away', () => {
    const t = fakeTerminal({ mode: 'vt200', buffer: 'alternate' })
    for (let i = 0; i < 12; i++) t.wheel(4)
    expect(t.ticks()).toHaveLength(2)
  })

  it('turns trackpad travel into the same ticks for arrow keys on the alternate screen', () => {
    const t = fakeTerminal({ mode: 'none', buffer: 'alternate', sensitivity: 2 })
    t.wheel(-17)
    expect(t.ticks().map((e) => e.deltaY)).toEqual([-1, -1])
  })

  it('leaves scrollback, Shift, line deltas and unmeasured cells to the terminal', () => {
    const scrollback = fakeTerminal({ mode: 'none', buffer: 'normal' })
    const plain = scrollback.wheel(51)
    expect(scrollback.handled).toEqual([plain])
    expect(plain.defaultPrevented).toBe(false)

    const app = fakeTerminal({ mode: 'any', buffer: 'alternate' })
    const shifted = app.wheel(51, { shiftKey: true })
    const lines = app.wheel(3, { deltaMode: WheelEvent.DOM_DELTA_LINE })
    expect(app.handled).toEqual([shifted, lines])

    const unmeasured = fakeTerminal({ mode: 'any', buffer: 'alternate', cellHeight: 0 })
    const early = unmeasured.wheel(51)
    expect(unmeasured.handled).toEqual([early])
  })

  it('sends a tick for every notch of a Linux wheel event and adds up the fractions', () => {
    const app = fakeTerminal({ mode: 'any', buffer: 'alternate', notches: true })
    app.wheel(120)
    app.wheel(-360)
    expect(app.ticks().map((e) => e.deltaY)).toEqual([1, -1, -1, -1])
    for (let i = 0; i < 16; i++) app.wheel(15)
    expect(app.ticks()).toHaveLength(6)

    const less = fakeTerminal({ mode: 'none', buffer: 'alternate', notches: true, sensitivity: 2 })
    less.wheel(240)
    expect(less.ticks().map((e) => e.deltaY)).toEqual([1, 1, 1, 1])
  })

  it('caps the ticks of one Linux wheel event at the terminal height', () => {
    const app = fakeTerminal({ mode: 'any', buffer: 'alternate', notches: true })
    app.wheel(120 * 100)
    expect(app.ticks()).toHaveLength(24)
  })

  it('swallows a delta too small for a row without letting it scroll the page', () => {
    const t = fakeTerminal({ mode: 'any', buffer: 'alternate' })
    const event = t.wheel(3)
    expect(event.defaultPrevented).toBe(true)
    expect(t.handled).toEqual([])
  })

  it('starts over when the screen or mouse mode changes', () => {
    const state = { mode: 'none' as TrackingMode, buffer: 'alternate' as 'normal' | 'alternate' }
    const t = fakeTerminal(state)
    t.wheel(10)
    state.buffer = 'normal'
    t.wheel(10)
    state.buffer = 'alternate'
    t.wheel(10)
    expect(t.ticks()).toHaveLength(0)
  })
})

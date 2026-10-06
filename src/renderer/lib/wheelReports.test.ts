import { describe, expect, it } from 'vitest'
import { type WheelTerminal, attachWheelReports, createWheelRows, wheelRoute } from './wheelReports'

const CELL = 17
const scale = { cellHeight: CELL, sensitivity: 1, maxRows: 40, notches: false }

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

  it('keeps a Linux wheel notch at one row and accumulates touchpad deltas', () => {
    const linux = { ...scale, notches: true }
    expect(createWheelRows().take(120, linux)).toBe(1)
    expect(createWheelRows().take(-53, linux)).toBe(-1)
    expect(createWheelRows().take(10_000, linux)).toBe(1)
    const rows = createWheelRows()
    expect([5, 5, 5, 5].map((d) => rows.take(d, linux))).toEqual([0, 0, 0, 1])
  })

  it('lets a Linux wheel notch drop the touchpad leftover', () => {
    const rows = createWheelRows()
    const linux = { ...scale, notches: true }
    expect(rows.take(10, linux)).toBe(0)
    expect(rows.take(120, linux)).toBe(1)
    expect(rows.take(10, linux)).toBe(0)
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

  it('leaves scrollback, Shift, line deltas and unmeasured cells to xterm', () => {
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

  it('sends one tick per Linux wheel notch and accumulates touchpad travel', () => {
    const app = fakeTerminal({ mode: 'any', buffer: 'alternate', notches: true })
    app.wheel(120)
    app.wheel(-100)
    expect(app.ticks().map((e) => e.deltaY)).toEqual([1, -1])
    for (let i = 0; i < 12; i++) app.wheel(4)
    expect(app.ticks()).toHaveLength(4)

    const less = fakeTerminal({ mode: 'none', buffer: 'alternate', notches: true })
    less.wheel(53)
    expect(less.ticks().map((e) => e.deltaY)).toEqual([1])
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

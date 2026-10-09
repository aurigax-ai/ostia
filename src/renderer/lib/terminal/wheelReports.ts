import type { OstiaTerminal as Terminal } from './ostiaTerminal'

export type WheelRoute = 'report' | 'arrows'

const WHEEL_NOTCH_DELTA = 50

const WHEEL_TRACKING_MODES: ReadonlySet<string> = new Set(['vt200', 'drag', 'any'])

export type WheelTerminal = Pick<
  Terminal,
  'attachCustomWheelEventHandler' | 'buffer' | 'element' | 'modes' | 'options' | 'rows'
>

export interface WheelScale {
  cellHeight: number
  sensitivity: number
  maxRows: number
  notches: boolean
}

export interface WheelRows {
  take: (deltaY: number, scale: WheelScale) => number
  reset: () => void
}

export function wheelRoute(
  mouseTrackingMode: Terminal['modes']['mouseTrackingMode'],
  bufferType: string,
): WheelRoute | null {
  if (WHEEL_TRACKING_MODES.has(mouseTrackingMode)) return 'report'
  return bufferType === 'alternate' ? 'arrows' : null
}

export function createWheelRows(): WheelRows {
  let pending = 0
  return {
    take: (deltaY, scale) => {
      if (deltaY === 0) return 0
      if (scale.notches && Math.abs(deltaY) >= WHEEL_NOTCH_DELTA) {
        pending = 0
        return Math.sign(deltaY)
      }
      if (!(scale.cellHeight > 0)) return 0
      if (Math.sign(deltaY) !== Math.sign(pending)) pending = 0
      pending += (deltaY * scale.sensitivity) / scale.cellHeight
      const rows = Math.trunc(pending) || 0
      pending -= rows
      return Math.max(-scale.maxRows, Math.min(scale.maxRows, rows))
    },
    reset: () => {
      pending = 0
    },
  }
}

function wheelTick(source: WheelEvent, direction: number): WheelEvent {
  return new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaMode: WheelEvent.DOM_DELTA_LINE,
    deltaY: direction,
    clientX: source.clientX,
    clientY: source.clientY,
    screenX: source.screenX,
    screenY: source.screenY,
    altKey: source.altKey,
    ctrlKey: source.ctrlKey,
    metaKey: source.metaKey,
  })
}

export function attachWheelReports(
  term: WheelTerminal,
  cellHeight: () => number,
  notches: boolean,
): void {
  const ticks = new WeakSet<WheelEvent>()
  const rows = createWheelRows()
  let lastRoute: WheelRoute | null = null
  term.attachCustomWheelEventHandler((e) => {
    if (ticks.has(e)) return true
    const route = wheelRoute(term.modes.mouseTrackingMode, term.buffer.active.type)
    if (route !== lastRoute) rows.reset()
    lastRoute = route
    const target = term.element
    if (!route || !target) return true
    if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || e.shiftKey || e.deltaY === 0) return true
    const height = cellHeight()
    if (!(height > 0)) return true
    e.preventDefault()
    e.stopPropagation()
    const count = rows.take(e.deltaY, {
      cellHeight: height,
      sensitivity: term.options.scrollSensitivity ?? 1,
      maxRows: Math.max(1, term.rows),
      notches,
    })
    for (let i = 0; i < Math.abs(count); i++) {
      const tick = wheelTick(e, Math.sign(count))
      ticks.add(tick)
      target.dispatchEvent(tick)
    }
    return false
  })
}

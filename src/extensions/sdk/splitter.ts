import { h, panelSize, savePanelSize, setPanelSize } from './panel'
import {
  type SplitBounds,
  clampPosition,
  fractionOf,
  keyPosition,
  percentOf,
  splitBounds,
} from './split'

export interface SplitOptions {
  key: string
  label: string
  first: HTMLElement
  second: HTMLElement
  defaultFraction: number
  minFirst: number
  minSecond: number
  collapseSecond?: boolean
}

const DRAGGING_CLASS = 'pine-split-dragging'
const observers = new Map<string, ResizeObserver>()

export function splitter(opts: SplitOptions): HTMLElement {
  const { first, second } = opts
  let fraction = panelSize(opts.key) ?? opts.defaultFraction
  const handle = h('div', {
    class: 'pine-split-handle',
    role: 'separator',
    tabindex: '0',
    'aria-orientation': 'horizontal',
    'aria-label': opts.label,
    'data-key': `split-${opts.key}`,
  })
  first.classList.add('pine-split-first')
  second.classList.add('pine-split-second')
  const container = h('div', { class: 'pine-split', 'data-split': opts.key }, first, handle, second)

  const total = (): number => Math.max(0, container.clientHeight - handle.offsetHeight)
  const bounds = (): SplitBounds => splitBounds(total(), opts.minFirst, opts.minSecond)

  const sync = (): void => {
    const size = total()
    const b = bounds()
    const collapsed = Boolean(opts.collapseSecond) && size > 0 && b.collapsed
    container.toggleAttribute('data-collapsed', collapsed)
    handle.hidden = collapsed
    const position = size > 0 ? first.getBoundingClientRect().height : 0
    handle.setAttribute('aria-valuemin', String(percentOf(b.min, size)))
    handle.setAttribute('aria-valuemax', String(percentOf(b.max, size)))
    handle.setAttribute('aria-valuenow', String(percentOf(position, size)))
  }

  const apply = (next: number): void => {
    fraction = next
    first.style.flexBasis = `clamp(${opts.minFirst}px, ${fraction * 100}%, calc(100% - ${opts.minSecond}px))`
    sync()
  }

  const commit = (position: number): void => {
    const next = fractionOf(position, total(), bounds())
    apply(next)
    setPanelSize(opts.key, next)
  }

  const persist = (): void => savePanelSize(opts.key, fraction)

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    handle.focus({ preventScroll: true })
    handle.setPointerCapture(e.pointerId)
    if (!handle.hasPointerCapture(e.pointerId)) return
    const startY = e.clientY
    const start = first.getBoundingClientRect().height
    document.documentElement.classList.add(DRAGGING_CLASS)
    const move = (ev: PointerEvent): void => commit(start + ev.clientY - startY)
    const end = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('lostpointercapture', end)
      document.documentElement.classList.remove(DRAGGING_CLASS)
      persist()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('lostpointercapture', end)
  })

  handle.addEventListener('dblclick', () => {
    setPanelSize(opts.key, null)
    apply(opts.defaultFraction)
    savePanelSize(opts.key, null)
  })

  handle.addEventListener('keydown', (e) => {
    const b = bounds()
    const current = clampPosition(first.getBoundingClientRect().height, b)
    const next = keyPosition(e.key, current, b)
    if (next === null) return
    e.preventDefault()
    commit(next)
    persist()
  })

  observers.get(opts.key)?.disconnect()
  const observer = new ResizeObserver(() => {
    if (!container.isConnected) {
      observer.disconnect()
      if (observers.get(opts.key) === observer) observers.delete(opts.key)
      return
    }
    sync()
  })
  observer.observe(container)
  observer.observe(first)
  observers.set(opts.key, observer)
  apply(fraction)
  return container
}

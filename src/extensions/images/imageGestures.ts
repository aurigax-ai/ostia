import { dragRegion } from './imageCrop'
import type { ImageSelection } from './imageSelection'
import { type Point, pinchZoom, type Size } from './imageZoom'
import type { ZoomView } from './imageZoomView'

type Gesture = { kind: 'pan'; client: Point; scroll: Point } | { kind: 'crop'; start: Point } | null

export function bindGestures(parts: {
  stage: HTMLElement
  canvas: HTMLElement
  natural: Size
  view: ZoomView
  selection: ImageSelection
}): void {
  const { stage, canvas, natural, view, selection } = parts
  let gesture: Gesture = null
  let spaceHeld = false

  const showPanCursor = (): void => {
    if (gesture?.kind === 'pan') stage.dataset.pan = 'active'
    else if (spaceHeld) stage.dataset.pan = 'ready'
    else delete stage.dataset.pan
  }
  const pointOf = (event: PointerEvent): Point =>
    view.contentPoint({ x: event.clientX, y: event.clientY })

  const startPan = (event: PointerEvent): void => {
    gesture = {
      kind: 'pan',
      client: { x: event.clientX, y: event.clientY },
      scroll: { x: stage.scrollLeft, y: stage.scrollTop },
    }
    stage.setPointerCapture(event.pointerId)
    showPanCursor()
    event.preventDefault()
  }

  stage.addEventListener('pointerdown', (event) => {
    if (event.button === 1) {
      startPan(event)
      return
    }
    if (event.button !== 0) return
    stage.focus({ preventScroll: true })
    if (spaceHeld) {
      startPan(event)
      return
    }
    selection.deselect()
    if (!canvas.contains(event.target as Node)) return
    gesture = { kind: 'crop', start: pointOf(event) }
    stage.setPointerCapture(event.pointerId)
    event.preventDefault()
  })

  stage.addEventListener('pointermove', (event) => {
    if (gesture?.kind === 'pan') {
      stage.scrollLeft = gesture.scroll.x - (event.clientX - gesture.client.x)
      stage.scrollTop = gesture.scroll.y - (event.clientY - gesture.client.y)
    } else if (gesture?.kind === 'crop') {
      selection.preview(dragRegion(gesture.start, pointOf(event), natural))
    }
  })

  const finish = (event: PointerEvent, cancelled: boolean): void => {
    const ended = gesture
    gesture = null
    showPanCursor()
    if (ended?.kind !== 'crop') return
    const dragged = cancelled ? null : dragRegion(ended.start, pointOf(event), natural)
    if (dragged) selection.select(dragged)
    else selection.deselect()
  }
  stage.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault()
  })
  stage.addEventListener('auxclick', (event) => {
    if (event.button === 1) event.preventDefault()
  })
  stage.addEventListener('pointerup', (event) => finish(event, false))
  stage.addEventListener('pointercancel', (event) => finish(event, true))

  stage.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      const next = pinchZoom(view.scale(), event.deltaY)
      if (next !== view.scale()) view.setZoom(next, { x: event.clientX, y: event.clientY })
    },
    { passive: false },
  )

  const releaseSpace = (): void => {
    spaceHeld = false
    showPanCursor()
  }
  document.addEventListener('keydown', (event) => {
    if (
      event.code !== 'Space' ||
      (event.target instanceof Element && event.target.closest('.ostia-pill'))
    )
      return
    event.preventDefault()
    spaceHeld = true
    showPanCursor()
  })
  document.addEventListener('keyup', (event) => {
    if (event.code === 'Space') releaseSpace()
  })
  window.addEventListener('blur', releaseSpace)
}

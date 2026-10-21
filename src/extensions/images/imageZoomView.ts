import {
  anchoredScroll,
  type Point,
  type Size,
  scaleOf,
  toContentPoint,
  type Zoom,
} from './imageZoom'

export interface ZoomView {
  scale: () => number
  zoom: () => Zoom
  setZoom: (next: Zoom, client?: Point) => void
  onViewChange: (listener: () => void) => void
  onLayout: (listener: (scale: number, zoom: Zoom) => void) => void
  contentPoint: (client: Point) => Point
  start: () => void
}

export function createZoomView(parts: {
  stage: HTMLElement
  canvas: HTMLElement
  natural: Size
}): ZoomView {
  const { stage, canvas, natural } = parts
  let zoom: Zoom = 'fit'
  const changes: Array<() => void> = []
  const layouts: Array<(scale: number, zoom: Zoom) => void> = []
  const stageSize = (): Size => ({ width: stage.offsetWidth, height: stage.offsetHeight })
  const scale = (): number => scaleOf(zoom, natural, stageSize())

  const layout = (): void => {
    const factor = scale()
    canvas.style.width = `${natural.width * factor}px`
    canvas.style.height = `${natural.height * factor}px`
    for (const listener of layouts) listener(factor, zoom)
  }

  const contentPoint = (client: Point): Point =>
    toContentPoint(client, canvas.getBoundingClientRect(), scale())

  const setZoom = (next: Zoom, client?: Point): void => {
    for (const listener of changes) listener()
    const box = stage.getBoundingClientRect()
    const at = client ?? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    const anchor = { content: contentPoint(at), client: at }
    zoom = next
    layout()
    const scroll = anchoredScroll(
      { x: stage.scrollLeft, y: stage.scrollTop },
      anchor,
      canvas.getBoundingClientRect(),
      scale(),
    )
    stage.scrollLeft = scroll.x
    stage.scrollTop = scroll.y
  }

  const start = (): void => {
    let last = stageSize()
    new ResizeObserver(() => {
      const size = stageSize()
      if (size.width === last.width && size.height === last.height) return
      last = size
      for (const listener of changes) listener()
      if (zoom === 'fit') layout()
    }).observe(stage)
    layout()
  }

  return {
    scale,
    zoom: () => zoom,
    setZoom,
    onViewChange: (listener) => changes.push(listener),
    onLayout: (listener) => layouts.push(listener),
    contentPoint,
    start,
  }
}

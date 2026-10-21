import type { Translate } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import type { ViewerRect } from '@aurigax-ai/ostia-extension-sdk/contract/viewerSelection'
import { createPill } from '@aurigax-ai/ostia-extension-sdk/pill'
import {
  clearSelection,
  onSelectionPublished,
  publishSelection,
} from '@aurigax-ai/ostia-extension-sdk/viewer'
import { cropRect, dragRegion, pageRect } from './imageCrop'
import { IMAGE_ICONS } from './imageIcons'
import { cropToPng } from './imageRaster'
import {
  anchoredScroll,
  formatPercent,
  menuPercent,
  type Point,
  pinchZoom,
  scaleOf,
  stepZoom,
  toContentPoint,
  ZOOM_MENU_PERCENTS,
  type Zoom,
  zoomPercent,
} from './imageZoom'

const STATUS_MS = 4000

type Gesture = { kind: 'pan'; client: Point; scroll: Point } | { kind: 'crop'; start: Point } | null

function element(className: string): HTMLDivElement {
  const node = document.createElement('div')
  node.className = className
  return node
}

function inPill(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.ostia-pill') !== null
}

export function mountImage(options: {
  root: HTMLElement
  image: HTMLImageElement
  name: string
  t: Translate
  locale: string
}): void {
  const { root, image, name, t, locale } = options
  const natural = { width: image.naturalWidth, height: image.naturalHeight }
  image.alt = name
  image.draggable = false
  const region = element('region')
  region.hidden = true
  const canvas = element('canvas')
  canvas.append(image, region)
  const stage = element('stage')
  stage.tabIndex = -1
  stage.append(canvas)
  const status = element('status')
  status.setAttribute('role', 'status')
  status.hidden = true
  root.replaceChildren(stage, status)

  let zoom: Zoom = 'fit'
  let gesture: Gesture = null
  let spaceHeld = false
  let selecting = false
  let selectedAt: Point = { x: 0, y: 0 }
  let token = 0
  let queue: Promise<void> = Promise.resolve()
  let statusTimer: ReturnType<typeof setTimeout> | undefined

  const enqueue = (operation: () => Promise<void>): void => {
    queue = queue.then(operation).catch(() => {})
  }
  const stageSize = () => ({ width: stage.offsetWidth, height: stage.offsetHeight })
  const scale = (): number => scaleOf(zoom, natural, stageSize())

  const drawRegion = (rect: ViewerRect | null): void => {
    region.hidden = rect === null
    if (!rect) return
    const factor = scale()
    region.style.left = `${rect.x * factor}px`
    region.style.top = `${rect.y * factor}px`
    region.style.width = `${rect.width * factor}px`
    region.style.height = `${rect.height * factor}px`
  }

  const showStatus = (text: string): void => {
    status.textContent = text
    status.hidden = false
    clearTimeout(statusTimer)
    statusTimer = setTimeout(() => {
      status.hidden = true
    }, STATUS_MS)
  }

  const deselect = (): void => {
    token++
    drawRegion(null)
    if (!selecting) return
    selecting = false
    enqueue(() => clearSelection())
  }

  onSelectionPublished((published) => {
    if (published || !selecting) return
    token++
    selecting = false
    drawRegion(null)
  })

  const select = (chosen: ViewerRect | null): void => {
    const mine = ++token
    selecting = true
    selectedAt = { x: stage.scrollLeft, y: stage.scrollTop }
    drawRegion(cropRect(chosen, natural))
    enqueue(async () => {
      if (mine !== token) return
      const png = await cropToPng(image, cropRect(chosen, natural)).catch(() => null)
      const rect =
        png &&
        pageRect(chosen, natural, canvas.getBoundingClientRect(), scale(), {
          width: window.innerWidth,
          height: window.innerHeight,
        })
      if (mine !== token) return
      const published =
        png && rect
          ? await publishSelection({
              capture: {
                kind: 'image',
                imageWidth: natural.width,
                imageHeight: natural.height,
                region: chosen,
              },
              rect,
              png,
            })
          : false
      if (mine !== token || published) return
      deselect()
      showStatus(t('captureFailed'))
    })
  }

  const pill = createPill({
    label: t('tools'),
    page: stage,
    controls: [
      {
        type: 'button',
        id: 'out',
        label: t('zoomOut'),
        chord: '-',
        icon: IMAGE_ICONS.zoomOut,
        onClick: () => setZoom(stepZoom(scale(), -1)),
      },
      {
        type: 'menu',
        id: 'zoom',
        label: t('zoomLevel'),
        text: '',
        items: [
          ZOOM_MENU_PERCENTS.map((percent) => ({
            id: String(percent),
            label: formatPercent(percent, locale),
          })),
        ],
        onPick: (id) => setZoom(Number(id) / 100),
      },
      {
        type: 'button',
        id: 'in',
        label: t('zoomIn'),
        chord: '+',
        icon: IMAGE_ICONS.zoomIn,
        onClick: () => setZoom(stepZoom(scale(), 1)),
      },
      {
        type: 'toggle',
        id: 'fit',
        label: t('fit'),
        chord: '0',
        icon: IMAGE_ICONS.fit,
        pressed: true,
        onToggle: (pressed) => setZoom(pressed ? 'fit' : scale()),
      },
      {
        type: 'button',
        id: 'actual',
        label: t('actualSize'),
        chord: '1',
        icon: IMAGE_ICONS.actualSize,
        onClick: () => setZoom(1),
      },
      {
        type: 'toggle',
        id: 'transparency',
        label: t('transparency'),
        icon: IMAGE_ICONS.transparency,
        onToggle: (on) => {
          canvas.dataset.grid = on ? 'on' : 'off'
        },
      },
    ],
  })

  const layout = (): void => {
    const factor = scale()
    canvas.style.width = `${natural.width * factor}px`
    canvas.style.height = `${natural.height * factor}px`
    const percent = zoomPercent(factor)
    const listed = menuPercent(factor)
    pill.setState('zoom', {
      text: formatPercent(percent, locale),
      checked: listed === null ? null : String(listed),
    })
    pill.setState('fit', { pressed: zoom === 'fit' })
  }

  function setZoom(next: Zoom, client?: Point): void {
    deselect()
    const box = stage.getBoundingClientRect()
    const at = client ?? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    const anchor = {
      content: toContentPoint(at, canvas.getBoundingClientRect(), scale()),
      client: at,
    }
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

  const showPanCursor = (): void => {
    if (gesture?.kind === 'pan') stage.dataset.pan = 'active'
    else if (spaceHeld) stage.dataset.pan = 'ready'
    else delete stage.dataset.pan
  }

  const contentPoint = (event: PointerEvent): Point =>
    toContentPoint({ x: event.clientX, y: event.clientY }, canvas.getBoundingClientRect(), scale())

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    stage.focus({ preventScroll: true })
    if (spaceHeld) {
      gesture = {
        kind: 'pan',
        client: { x: event.clientX, y: event.clientY },
        scroll: { x: stage.scrollLeft, y: stage.scrollTop },
      }
      stage.setPointerCapture(event.pointerId)
      showPanCursor()
      event.preventDefault()
      return
    }
    deselect()
    if (!canvas.contains(event.target as Node)) return
    gesture = { kind: 'crop', start: contentPoint(event) }
    stage.setPointerCapture(event.pointerId)
    event.preventDefault()
  })

  stage.addEventListener('pointermove', (event) => {
    if (gesture?.kind === 'pan') {
      stage.scrollLeft = gesture.scroll.x - (event.clientX - gesture.client.x)
      stage.scrollTop = gesture.scroll.y - (event.clientY - gesture.client.y)
    } else if (gesture?.kind === 'crop') {
      drawRegion(dragRegion(gesture.start, contentPoint(event), natural))
    }
  })

  const finish = (event: PointerEvent, cancelled: boolean): void => {
    const ended = gesture
    gesture = null
    showPanCursor()
    if (ended?.kind !== 'crop') return
    const dragged = cancelled ? null : dragRegion(ended.start, contentPoint(event), natural)
    if (dragged) select(dragged)
    else deselect()
  }
  stage.addEventListener('pointerup', (event) => finish(event, false))
  stage.addEventListener('pointercancel', (event) => finish(event, true))

  stage.addEventListener('scroll', () => {
    if (stage.scrollLeft !== selectedAt.x || stage.scrollTop !== selectedAt.y) deselect()
  })
  stage.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      const next = pinchZoom(scale(), event.deltaY)
      if (next !== scale()) setZoom(next, { x: event.clientX, y: event.clientY })
    },
    { passive: false },
  )

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      deselect()
      return
    }
    if (inPill(event.target)) return
    if (event.code === 'Space') {
      event.preventDefault()
      spaceHeld = true
      showPanCursor()
      return
    }
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase()
      if (key === 'a' || (key === 'c' && !selecting)) {
        event.preventDefault()
        select(null)
      }
      return
    }
    if (event.altKey) return
    if (event.key === '+' || event.key === '=') setZoom(stepZoom(scale(), 1))
    else if (event.key === '-') setZoom(stepZoom(scale(), -1))
    else if (event.key === '0') setZoom('fit')
    else if (event.key === '1') setZoom(1)
  })
  const releaseSpace = (): void => {
    spaceHeld = false
    showPanCursor()
  }
  document.addEventListener('keyup', (event) => {
    if (event.code === 'Space') releaseSpace()
  })
  window.addEventListener('blur', releaseSpace)

  let lastSize = stageSize()
  new ResizeObserver(() => {
    const size = stageSize()
    if (size.width === lastSize.width && size.height === lastSize.height) return
    lastSize = size
    deselect()
    if (zoom === 'fit') layout()
  }).observe(stage)
  layout()
}

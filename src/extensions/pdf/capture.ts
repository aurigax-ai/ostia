import { VIEWER_TEXT_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/viewerSelection'
import { h } from '@aurigax-ai/ostia-extension-sdk/panel'
import {
  clearSelection,
  onSelectionCleared,
  publishSelection,
} from '@aurigax-ai/ostia-extension-sdk/viewer'
import type { PageView } from './pageView'
import {
  dragIntent,
  dragRect,
  inPageUnits,
  isClick,
  type LinkTarget,
  linkAt,
  type Point,
  pixelRect,
  type Rect,
  textInRect,
} from './pdfSelection'

export interface CaptureOptions {
  pageOf: (element: Element | null) => PageView | null
  scale: () => number
  rotation: () => number
  cropMode: () => boolean
  onLink: (target: LinkTarget) => void
}

export interface Capture {
  clear: () => void
  clearRegion: () => void
  destroy: () => void
}

type Drag =
  | { kind: 'crop'; view: PageView; from: Point; box: HTMLElement; label: HTMLElement }
  | { kind: 'text'; view: PageView; from: Point }

function isTextSpan(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLSpanElement &&
    !target.classList.contains('markedContent') &&
    target.closest('.pdf-text') !== null
  )
}

function cropCanvas(canvas: HTMLCanvasElement, area: Rect): Promise<Blob | null> {
  const out = document.createElement('canvas')
  out.width = area.width
  out.height = area.height
  out
    .getContext('2d')
    ?.drawImage(canvas, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height)
  return new Promise((resolve) => out.toBlob(resolve, 'image/png'))
}

function viewportRect(box: DOMRect): Rect {
  return { x: box.left, y: box.top, width: box.width, height: box.height }
}

export function attachCapture(options: CaptureOptions): Capture {
  let drag: Drag | null = null
  let overlay: HTMLElement | null = null
  let published = false
  let publishedKind: 'crop' | 'text' | null = null
  let token = 0

  const removeOverlay = (): void => {
    overlay?.remove()
    overlay = null
  }

  const clear = (): void => {
    token++
    removeOverlay()
    if (!published) return
    published = false
    publishedKind = null
    window.getSelection()?.removeAllRanges()
    void clearSelection()
  }

  const endDrag = (): void => {
    if (drag?.kind === 'crop') drag.box.remove()
    drag = null
  }

  const point = (event: MouseEvent): Point => ({ x: event.clientX, y: event.clientY })

  const link = (view: PageView, at: Point): void => {
    const hit = linkAt(view.linksAt(), view.toPageUnits(at))
    if (hit) options.onLink(hit.target)
  }

  const publishCrop = async (view: PageView, region: Rect, box: HTMLElement): Promise<void> => {
    const canvas = view.canvasElement
    if (!canvas) return
    const mine = ++token
    overlay = box
    const page = view.element.getBoundingClientRect()
    const factor = canvas.width / Math.max(1, page.width)
    const area = pixelRect(region, factor, { width: canvas.width, height: canvas.height })
    const png = await cropCanvas(canvas, area)
    if (!png || mine !== token) return
    const text = textInRect(view.textBoxes(), region).slice(0, VIEWER_TEXT_MAX)
    const scale = options.scale()
    const unit = view.sizeAt({ scale: 1, rotation: options.rotation() })
    const ok = await publishSelection({
      capture: {
        kind: 'pdf-region',
        page: view.number,
        pageWidth: Math.round(unit.width * 100) / 100,
        pageHeight: Math.round(unit.height * 100) / 100,
        region: inPageUnits(region, scale),
      },
      rect: viewportRect(box.getBoundingClientRect()),
      png,
      ...(text ? { text } : {}),
    })
    if (mine !== token) return
    published = ok
    publishedKind = ok ? 'crop' : null
    if (!ok) removeOverlay()
  }

  const publishText = async (): Promise<void> => {
    const selection = window.getSelection()
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    const text = selection?.toString() ?? ''
    if (!range || selection?.isCollapsed || !text.trim()) return
    const pages = [selection?.anchorNode, selection?.focusNode]
      .map((node) => options.pageOf(node instanceof Element ? node : (node?.parentElement ?? null)))
      .filter((view): view is PageView => view !== null)
      .map((view) => view.number)
    if (pages.length === 0) return
    const mine = ++token
    const ok = await publishSelection({
      capture: { kind: 'pdf-text', firstPage: Math.min(...pages), lastPage: Math.max(...pages) },
      rect: viewportRect(range.getBoundingClientRect()),
      text: text.slice(0, VIEWER_TEXT_MAX),
    })
    if (mine === token) {
      published = ok
      publishedKind = ok ? 'text' : null
    }
  }

  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    clear()
    const view = options.pageOf(event.target instanceof Element ? event.target : null)
    if (!view) return
    const from = point(event)
    const intent = dragIntent({
      overText: isTextSpan(event.target),
      pageHasText: view.hasText,
      cropMode: options.cropMode(),
      alt: event.altKey,
    })
    if (intent === 'text') {
      drag = { kind: 'text', view, from }
      return
    }
    event.preventDefault()
    const label = h('span', { class: 'pdf-crop-size' }) as HTMLElement
    const box = h('div', { class: 'pdf-crop' }, label) as HTMLElement
    box.hidden = true
    view.element.append(box)
    drag = { kind: 'crop', view, from, box, label }
  }

  const onMove = (event: PointerEvent): void => {
    if (drag?.kind === 'crop') {
      const local = drag.view.toLocal(point(event))
      const start = drag.view.toLocal(drag.from)
      const bounds = drag.view.element.getBoundingClientRect()
      const region = dragRect(start, local, { width: bounds.width, height: bounds.height })
      drag.box.hidden = region === null
      if (region) {
        Object.assign(drag.box.style, {
          left: `${region.x}px`,
          top: `${region.y}px`,
          width: `${region.width}px`,
          height: `${region.height}px`,
        })
        drag.label.textContent = `${Math.round(region.width / options.scale())} × ${Math.round(region.height / options.scale())}`
      }
      return
    }
    if (event.buttons === 0) {
      const view = options.pageOf(event.target instanceof Element ? event.target : null)
      const over = view ? linkAt(view.linksAt(), view.toPageUnits(point(event))) : null
      document.body.classList.toggle('pdf-over-link', over !== null)
    }
  }

  const onUp = (event: PointerEvent): void => {
    const current = drag
    drag = null
    if (!current) return
    const at = point(event)
    if (current.kind === 'text') {
      if (isClick(current.from, at) && window.getSelection()?.isCollapsed !== false) {
        link(current.view, at)
      } else void publishText()
      return
    }
    const bounds = current.view.element.getBoundingClientRect()
    const region = dragRect(current.view.toLocal(current.from), current.view.toLocal(at), {
      width: bounds.width,
      height: bounds.height,
    })
    if (!region) {
      current.box.remove()
      if (isClick(current.from, at)) link(current.view, at)
      return
    }
    void publishCrop(current.view, region, current.box)
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    if (drag) endDrag()
    else clear()
  }

  const onMouseDown = (event: MouseEvent): void => {
    if (drag?.kind === 'crop') event.preventDefault()
  }

  const stopCleared = onSelectionCleared(clear)
  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('mousedown', onMouseDown, true)
  document.addEventListener('pointermove', onMove, true)
  document.addEventListener('pointerup', onUp, true)
  document.addEventListener('keydown', onKey)

  return {
    clear: () => {
      endDrag()
      clear()
    },
    clearRegion: () => {
      if (drag?.kind === 'crop' || publishedKind === 'crop' || overlay) {
        endDrag()
        clear()
      }
    },
    destroy: () => {
      stopCleared()
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerup', onUp, true)
      document.removeEventListener('keydown', onKey)
    },
  }
}

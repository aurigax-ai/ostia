import { h } from '@aurigax-ai/ostia-extension-sdk/panel'
import type { PDFPageProxy, RenderTask, TextLayer } from 'pdfjs-dist'
import { type PdfDocument, pdfjs } from './pdfjs'
import { MAX_CANVAS_PIXELS, renderRatio, type Size, turnedSize } from './pdfLayout'
import {
  type LinkTarget,
  type PageLink,
  type Point,
  type TextBox,
  transformedRect,
} from './pdfSelection'

export interface ViewState {
  scale: number
  rotation: number
}

interface Annotation {
  subtype?: string
  rect?: number[]
  url?: string
  unsafeUrl?: string
  dest?: string | unknown[]
  action?: string
}

const ACTION_STEPS: Record<string, 'next' | 'previous' | 'first' | 'last'> = {
  NextPage: 'next',
  PrevPage: 'previous',
  FirstPage: 'first',
  LastPage: 'last',
}

function targetOf(annotation: Annotation): LinkTarget | null {
  const url = annotation.url ?? annotation.unsafeUrl
  if (url) return { kind: 'url', url }
  if (annotation.dest) return { kind: 'dest', dest: annotation.dest }
  const step = annotation.action ? ACTION_STEPS[annotation.action] : undefined
  return step ? { kind: 'step', step } : null
}

export class PageView {
  readonly element: HTMLElement
  readonly number: number
  private base: Size
  private page: Promise<PDFPageProxy> | null = null
  private canvas: HTMLCanvasElement | null = null
  private text: HTMLElement
  private textLayer: TextLayer | null = null
  private task: RenderTask | null = null
  private generation = 0
  private links: PageLink[] = []
  private textPresent = false
  private view: ViewState = { scale: 1, rotation: 0 }

  constructor(
    private doc: PdfDocument,
    number: number,
    base: Size,
    private onLoaded: (view: PageView) => void,
    private onRendered: (view: PageView) => void,
  ) {
    this.number = number
    this.base = base
    this.text = h('div', { class: 'pdf-text' }) as HTMLElement
    this.element = h(
      'div',
      { class: 'pdf-page', 'data-page': String(number) },
      this.text,
    ) as HTMLElement
    this.applySize()
  }

  get unrotatedSize(): Size {
    return this.base
  }

  get hasText(): boolean {
    return this.textPresent
  }

  get isRendered(): boolean {
    return this.canvas !== null && this.textLayer !== null
  }

  get canvasElement(): HTMLCanvasElement | null {
    return this.canvas
  }

  get textElement(): HTMLElement {
    return this.text
  }

  sizeAt(view: ViewState): Size {
    const turned = turnedSize(this.base, view.rotation)
    return { width: turned.width * view.scale, height: turned.height * view.scale }
  }

  setView(view: ViewState): void {
    this.view = view
    this.applySize()
  }

  private applySize(): void {
    const size = this.sizeAt(this.view)
    this.element.style.width = `${size.width}px`
    this.element.style.height = `${size.height}px`
    this.element.style.setProperty('--total-scale-factor', String(this.view.scale))
  }

  load(): Promise<PDFPageProxy> {
    this.page ??= this.doc.getPage(this.number).then((page) => {
      const viewport = page.getViewport({ scale: 1 })
      this.base = { width: viewport.width, height: viewport.height }
      this.applySize()
      this.onLoaded(this)
      return page
    })
    return this.page
  }

  async render(view: ViewState): Promise<void> {
    const generation = ++this.generation
    this.task?.cancel()
    this.textLayer?.cancel()
    this.view = view
    const page = await this.load()
    if (generation !== this.generation) return
    const viewport = page.getViewport({
      scale: view.scale,
      rotation: (page.rotate + view.rotation) % 360,
    })
    const ratio = renderRatio(viewport, window.devicePixelRatio || 1, MAX_CANVAS_PIXELS)
    const canvas = h('canvas', { class: 'pdf-canvas' }) as HTMLCanvasElement
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
    const task = page.render({
      canvas,
      viewport,
      ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }),
    })
    this.task = task
    try {
      await task.promise
    } catch {
      return
    }
    if (generation !== this.generation) return
    const text = h('div', { class: 'pdf-text' }) as HTMLElement
    const layer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: text,
      viewport,
    })
    this.textLayer = layer
    try {
      await layer.render()
    } catch {
      return
    }
    if (generation !== this.generation) return
    const links = await this.readLinks(page, view)
    if (generation !== this.generation) return
    this.textPresent = layer.textContentItemsStr.some((str) => str.trim() !== '')
    if (this.canvas) this.canvas.replaceWith(canvas)
    else this.element.prepend(canvas)
    this.text.replaceWith(text)
    this.text = text
    this.canvas = canvas
    this.links = links
    this.onRendered(this)
  }

  private async readLinks(page: PDFPageProxy, view: ViewState): Promise<PageLink[]> {
    const unit = page.getViewport({ scale: 1, rotation: (page.rotate + view.rotation) % 360 })
    const annotations = (await page
      .getAnnotations({ intent: 'display' })
      .catch(() => [])) as Annotation[]
    const links: PageLink[] = []
    for (const annotation of annotations) {
      const target = annotation.subtype === 'Link' ? targetOf(annotation) : null
      if (!target || annotation.rect?.length !== 4) continue
      links.push({ rect: transformedRect(annotation.rect, unit.transform), target })
    }
    return links
  }

  release(): void {
    this.generation++
    this.task?.cancel()
    this.textLayer?.cancel()
    this.task = null
    this.textLayer = null
    if (this.canvas) {
      this.canvas.width = 0
      this.canvas.height = 0
      this.canvas.remove()
      this.canvas = null
    }
    this.text.replaceChildren()
    this.links = []
    void this.page?.then((page) => page.cleanup())
  }

  linksAt(): readonly PageLink[] {
    return this.links
  }

  toPageUnits(point: Point): Point {
    const box = this.element.getBoundingClientRect()
    return { x: (point.x - box.left) / this.view.scale, y: (point.y - box.top) / this.view.scale }
  }

  toLocal(point: Point): Point {
    const box = this.element.getBoundingClientRect()
    return { x: point.x - box.left, y: point.y - box.top }
  }

  textBoxes(): TextBox[] {
    const origin = this.element.getBoundingClientRect()
    const boxes: TextBox[] = []
    for (const span of this.text.querySelectorAll('span:not(.markedContent)')) {
      const text = span.textContent ?? ''
      if (!text) continue
      const box = span.getBoundingClientRect()
      boxes.push({
        text,
        rect: {
          x: box.left - origin.left,
          y: box.top - origin.top,
          width: box.width,
          height: box.height,
        },
      })
    }
    return boxes
  }
}

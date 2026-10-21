import { h } from '@aurigax-ai/ostia-extension-sdk/panel'
import { PageView, type ViewState } from './pageView'
import type { PdfDocument } from './pdfjs'
import { currentPage, PAGE_GAP, type Size } from './pdfLayout'

const SETTLE_MS = 120

export interface PagesHooks {
  onCurrent: (page: number) => void
  onRendered: (view: PageView) => void
  onFirstSize: () => void
}

export interface ScrollAnchor {
  index: number
  fraction: number
  offset: number
}

export class Pages {
  readonly element = h('div', { class: 'pdf-pages' }) as HTMLElement
  readonly views: PageView[]
  private view: ViewState = { scale: 1, rotation: 0 }
  private live = new Set<PageView>()
  private observer: IntersectionObserver
  private settle: ReturnType<typeof setTimeout> | null = null
  private frame = 0
  private shown = 0

  constructor(
    doc: PdfDocument,
    firstSize: Size,
    private hooks: PagesHooks,
  ) {
    this.views = Array.from(
      { length: doc.numPages },
      (_, index) =>
        new PageView(
          doc,
          index + 1,
          firstSize,
          (loaded) => {
            if (loaded.number === 1) hooks.onFirstSize()
          },
          (rendered) => hooks.onRendered(rendered),
        ),
    )
    this.element.append(...this.views.map((view) => view.element))
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) this.watch(entry)
      },
      { rootMargin: '100% 0px' },
    )
    for (const view of this.views) this.observer.observe(view.element)
    window.addEventListener('scroll', this.onScroll, { passive: true })
  }

  private watch(entry: IntersectionObserverEntry): void {
    const view = this.views[Number((entry.target as HTMLElement).dataset.page) - 1]
    if (!view) return
    if (entry.isIntersecting) {
      this.live.add(view)
      void view.render(this.view)
    } else {
      this.live.delete(view)
      view.release()
    }
  }

  private onScroll = (): void => {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.updateCurrent()
    })
  }

  private updateCurrent(): void {
    const root = document.scrollingElement as HTMLElement
    const offset = this.element.offsetTop
    const page = currentPage(
      {
        count: this.views.length,
        top: (index) => offset + this.views[index].element.offsetTop,
        height: (index) => this.views[index].element.offsetHeight,
      },
      { scrollTop: root.scrollTop, height: root.clientHeight, scrollHeight: root.scrollHeight },
    )
    if (page !== this.shown) {
      this.shown = page
      this.hooks.onCurrent(page)
    }
  }

  get current(): number {
    return this.shown
  }

  get state(): ViewState {
    return this.view
  }

  anchorAt(clientY: number): ScrollAnchor {
    let index = this.views.findIndex(
      (view) => view.element.getBoundingClientRect().bottom > clientY,
    )
    if (index < 0) index = this.views.length - 1
    const box = this.views[index].element.getBoundingClientRect()
    return { index, fraction: (clientY - box.top) / Math.max(1, box.height), offset: clientY }
  }

  restore(anchor: ScrollAnchor): void {
    const box = this.views[anchor.index].element.getBoundingClientRect()
    window.scrollBy(0, box.top + anchor.fraction * box.height - anchor.offset)
  }

  setView(next: ViewState): void {
    this.view = next
    for (const view of this.views) view.setView(next)
    if (this.settle) clearTimeout(this.settle)
    this.settle = setTimeout(() => {
      for (const view of this.live) void view.render(this.view)
    }, SETTLE_MS)
    this.updateCurrent()
  }

  goTo(page: number): void {
    const view = this.views[page - 1]
    if (!view) return
    const target = this.element.offsetTop + view.element.offsetTop - PAGE_GAP
    window.scrollTo({ top: target })
    this.shown = page
    this.hooks.onCurrent(page)
  }

  destroy(): void {
    window.removeEventListener('scroll', this.onScroll)
    this.observer.disconnect()
    if (this.settle) clearTimeout(this.settle)
  }
}

import { h } from '@aurigax-ai/ostia-extension-sdk/panel'
import type { PdfDocument } from './pdfjs'
import type { LinkTarget } from './pdfSelection'

const THUMB_WIDTH = 124

export interface OutlineNode {
  title: string
  dest?: string | unknown[] | null
  url?: string | null
  items?: OutlineNode[]
}

interface SidebarLabels {
  sidebar: string
  tabs: string
  pages: string
  outline: string
  thumbnail: (page: number) => string
}

export interface Sidebar {
  element: HTMLElement
  setOpen: (open: boolean) => void
  isOpen: () => boolean
  setCurrent: (page: number) => void
}

interface SidebarOptions {
  doc: PdfDocument
  labels: SidebarLabels
  outline: OutlineNode[] | null
  firstAspect: number
  onGo: (page: number) => void
  onTarget: (target: LinkTarget) => void
}

function thumbnails(options: SidebarOptions): {
  list: HTMLElement
  setCurrent: (page: number) => void
} {
  const { doc, labels, firstAspect, onGo } = options
  const list = h('div', { class: 'pdf-thumbs', role: 'list' }) as HTMLElement
  const items: HTMLElement[] = []
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const item = entry.target as HTMLElement
        observer.unobserve(item)
        void draw(item)
      }
    },
    { rootMargin: '200px 0px' },
  )
  async function draw(item: HTMLElement): Promise<void> {
    const number = Number(item.dataset.page)
    const page = await doc.getPage(number).catch(() => null)
    const canvas = item.querySelector('canvas')
    if (!page || !canvas) return
    const unit = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: THUMB_WIDTH / unit.width })
    const ratio = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.floor(viewport.width * ratio)
    canvas.height = Math.floor(viewport.height * ratio)
    canvas.style.height = `${viewport.height}px`
    await page
      .render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
      .promise.catch(() => undefined)
    page.cleanup()
  }
  for (let number = 1; number <= doc.numPages; number++) {
    const canvas = h('canvas', { class: 'pdf-thumb-canvas' }) as HTMLCanvasElement
    canvas.style.width = `${THUMB_WIDTH}px`
    canvas.style.height = `${THUMB_WIDTH * firstAspect}px`
    const item = h(
      'button',
      {
        type: 'button',
        class: 'pdf-thumb',
        role: 'listitem',
        'data-page': String(number),
        'aria-label': labels.thumbnail(number),
      },
      canvas,
      h('span', { class: 'pdf-thumb-number' }, String(number)),
    ) as HTMLElement
    item.addEventListener('click', () => onGo(number))
    items.push(item)
    list.append(item)
    observer.observe(item)
  }
  return {
    list,
    setCurrent: (page) => {
      items.forEach((item, index) => {
        item.setAttribute('aria-current', String(index + 1 === page))
      })
      items[page - 1]?.scrollIntoView({ block: 'nearest' })
    },
  }
}

function outlineList(nodes: OutlineNode[], onTarget: (target: LinkTarget) => void): HTMLElement {
  const list = h('ul', { class: 'pdf-outline' }) as HTMLElement
  for (const node of nodes) {
    const row = h('button', { type: 'button', class: 'pdf-outline-row' }, node.title) as HTMLElement
    row.addEventListener('click', () => {
      if (node.url) onTarget({ kind: 'url', url: node.url })
      else if (node.dest) onTarget({ kind: 'dest', dest: node.dest })
    })
    const item = h('li', {}, row) as HTMLElement
    if (node.items?.length) item.append(outlineList(node.items, onTarget))
    list.append(item)
  }
  return list
}

export function createSidebar(options: SidebarOptions): Sidebar {
  const { labels, outline } = options
  const thumbs = thumbnails(options)
  const pagesPanel = h(
    'div',
    { class: 'pdf-sidebar-panel', role: 'tabpanel' },
    thumbs.list,
  ) as HTMLElement
  const panels: HTMLElement[] = [pagesPanel]
  const tabs = h('div', {
    class: 'pdf-sidebar-tabs',
    role: 'tablist',
    'aria-label': labels.tabs,
  }) as HTMLElement
  const element = h(
    'aside',
    { class: 'pdf-sidebar', 'aria-label': labels.sidebar },
    tabs,
    pagesPanel,
  ) as HTMLElement
  element.hidden = true
  if (outline && outline.length > 0) {
    const outlinePanel = h(
      'div',
      { class: 'pdf-sidebar-panel', role: 'tabpanel' },
      outlineList(outline, options.onTarget),
    ) as HTMLElement
    outlinePanel.hidden = true
    panels.push(outlinePanel)
    element.append(outlinePanel)
    const names = [labels.pages, labels.outline]
    const buttons = names.map((name, index) => {
      const tab = h(
        'button',
        { type: 'button', class: 'pdf-sidebar-tab', role: 'tab' },
        name,
      ) as HTMLElement
      tab.addEventListener('click', () => {
        panels.forEach((panel, at) => {
          panel.hidden = at !== index
        })
        buttons.forEach((other, at) => other.setAttribute('aria-selected', String(at === index)))
      })
      return tab
    })
    buttons[0].setAttribute('aria-selected', 'true')
    buttons[1].setAttribute('aria-selected', 'false')
    tabs.append(...buttons)
  } else {
    tabs.hidden = true
  }
  let page = 1
  return {
    element,
    setOpen: (open) => {
      element.hidden = !open
      document.body.classList.toggle('pdf-sidebar-open', open)
      if (open) thumbs.setCurrent(page)
    },
    isOpen: () => !element.hidden,
    setCurrent: (next) => {
      page = next
      if (!element.hidden) thumbs.setCurrent(next)
    },
  }
}

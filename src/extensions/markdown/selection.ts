export interface SourceLines {
  startLine: number
  endLine: number
}

export interface PreviewSelection extends SourceLines {
  text: string
  rect: { x: number; y: number; width: number; height: number }
}

export interface SelectionSink {
  publish: (selection: PreviewSelection) => void
  clear: () => void
}

const SETTLE_MS = 150

function elementOf(node: Node): Element | null {
  return node.nodeType === 1 ? (node as Element) : node.parentElement
}

function lineAttr(node: Node, root: HTMLElement, attr: string): number | null {
  const el = elementOf(node)?.closest(`[${attr}]`)
  if (!el || !root.contains(el)) return null
  const n = Number(el.getAttribute(attr))
  return Number.isInteger(n) && n > 0 ? n : null
}

export function sourceLinesOf(range: Range, root: HTMLElement): SourceLines | null {
  const startLine = lineAttr(range.startContainer, root, 'data-line-start')
  const endLine = lineAttr(range.endContainer, root, 'data-line-end')
  if (startLine === null || endLine === null) return null
  return { startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine) }
}

export function currentSelection(article: HTMLElement): PreviewSelection | null {
  const selection = article.ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const text = range.toString()
  if (range.collapsed || text.trim() === '') return null
  if (!article.contains(range.commonAncestorContainer)) return null
  const lines = sourceLinesOf(range, article)
  if (!lines) return null
  const { x, y, width, height } = range.getBoundingClientRect()
  return { text, ...lines, rect: { x, y, width, height } }
}

export interface SelectionTracker {
  sync: () => void
  destroy: () => void
}

export function trackSelection(article: HTMLElement, sink: SelectionSink): SelectionTracker {
  const doc = article.ownerDocument
  const win = doc.defaultView as Window
  let published: string | null = null
  let scrolling: ReturnType<typeof setTimeout> | null = null

  const forget = (): void => {
    if (published === null) return
    published = null
    sink.clear()
  }
  const sync = (): void => {
    const selection = currentSelection(article)
    if (!selection) {
      forget()
      return
    }
    const key = JSON.stringify(selection)
    if (key === published) return
    published = key
    sink.publish(selection)
  }
  const settle = (): void => {
    setTimeout(sync, 0)
  }
  const onScroll = (): void => {
    if (scrolling) clearTimeout(scrolling)
    scrolling = setTimeout(sync, SETTLE_MS)
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    doc.getSelection()?.removeAllRanges()
    forget()
  }

  doc.addEventListener('pointerdown', forget, true)
  doc.addEventListener('pointerup', settle, true)
  doc.addEventListener('keyup', settle, true)
  doc.addEventListener('keydown', onKeyDown, true)
  win.addEventListener('scroll', onScroll)
  return {
    sync,
    destroy: () => {
      doc.removeEventListener('pointerdown', forget, true)
      doc.removeEventListener('pointerup', settle, true)
      doc.removeEventListener('keyup', settle, true)
      doc.removeEventListener('keydown', onKeyDown, true)
      win.removeEventListener('scroll', onScroll)
      if (scrolling) clearTimeout(scrolling)
      forget()
    },
  }
}

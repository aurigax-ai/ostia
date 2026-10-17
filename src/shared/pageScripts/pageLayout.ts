/// <reference lib="dom" />

export function createLayout(win: Window & typeof globalThis) {
  const hasLayoutApi = (el: Element): boolean =>
    typeof (el as Element & { checkVisibility?: unknown }).checkVisibility === 'function'

  const hasBox = (el: Element): boolean => !hasLayoutApi(el) || el.getClientRects().length > 0

  const isRendered = (el: Element): boolean => {
    if (!el.isConnected) return false
    if (hasLayoutApi(el)) {
      return (el as Element & { checkVisibility: (o?: object) => boolean }).checkVisibility({
        visibilityProperty: true,
      })
    }
    const view = el.ownerDocument.defaultView ?? win
    let node: Element | null = el
    while (node) {
      if (node.hasAttribute('hidden')) return false
      const style = view.getComputedStyle(node)
      if (style.display === 'none') return false
      if (node === el && style.visibility === 'hidden') return false
      node = node.parentElement
    }
    return true
  }

  const isVisible = (el: Element): boolean => isRendered(el) && hasBox(el)

  const frameOffset = (el: Element): { x: number; y: number } => {
    let x = 0
    let y = 0
    let view = el.ownerDocument.defaultView
    while (view && view !== win && view.frameElement) {
      const frameRect = view.frameElement.getBoundingClientRect()
      x += frameRect.left + (view.frameElement as HTMLElement).clientLeft
      y += frameRect.top + (view.frameElement as HTMLElement).clientTop
      view = view.frameElement.ownerDocument.defaultView
    }
    return { x, y }
  }

  return { hasBox, isRendered, isVisible, frameOffset }
}

export type PageLayout = ReturnType<typeof createLayout>

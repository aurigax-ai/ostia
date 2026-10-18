export const SCROLLBAR_SIZE_PX = 11
export const SCROLL_IDLE_MS = 500
export const SCROLLING_ATTRIBUTE = 'data-scrolling'

export function watchScrolling(doc: Document): () => void {
  const win = doc.defaultView
  if (!win) return () => {}
  const timers = new Map<Element, number>()
  const onScroll = (event: Event): void => {
    const target = event.target === doc ? doc.documentElement : (event.target as Element)
    target.setAttribute(SCROLLING_ATTRIBUTE, '')
    win.clearTimeout(timers.get(target))
    timers.set(
      target,
      win.setTimeout(() => {
        target.removeAttribute(SCROLLING_ATTRIBUTE)
        timers.delete(target)
      }, SCROLL_IDLE_MS),
    )
  }
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => {
    doc.removeEventListener('scroll', onScroll, { capture: true })
    for (const [target, timer] of timers) {
      win.clearTimeout(timer)
      target.removeAttribute(SCROLLING_ATTRIBUTE)
    }
    timers.clear()
  }
}

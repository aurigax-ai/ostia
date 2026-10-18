export const SCROLLBAR_SIZE_PX = 11
export const SCROLL_IDLE_MS = 500
export const SCROLLING_ATTRIBUTE = 'data-scrolling'
export const SCROLLBAR_HOVER_ATTRIBUTE = 'data-scrollbar-hover'

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
  let hovered: Element | null = null
  const setHovered = (next: Element | null): void => {
    if (next === hovered) return
    hovered?.removeAttribute(SCROLLBAR_HOVER_ATTRIBUTE)
    next?.setAttribute(SCROLLBAR_HOVER_ATTRIBUTE, '')
    hovered = next
  }
  const onPointerMove = (event: PointerEvent): void => {
    const target = event.target === doc ? doc.documentElement : (event.target as HTMLElement)
    const overVertical =
      target.clientWidth < target.offsetWidth && event.offsetX >= target.clientWidth
    const overHorizontal =
      target.clientHeight < target.offsetHeight && event.offsetY >= target.clientHeight
    setHovered(overVertical || overHorizontal ? target : null)
  }
  const onPointerOut = (event: PointerEvent): void => {
    if (event.relatedTarget === null) setHovered(null)
  }
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
  doc.addEventListener('pointermove', onPointerMove, { passive: true })
  doc.addEventListener('pointerout', onPointerOut, { passive: true })
  return () => {
    doc.removeEventListener('scroll', onScroll, { capture: true })
    doc.removeEventListener('pointermove', onPointerMove)
    doc.removeEventListener('pointerout', onPointerOut)
    setHovered(null)
    for (const [target, timer] of timers) {
      win.clearTimeout(timer)
      target.removeAttribute(SCROLLING_ATTRIBUTE)
    }
    timers.clear()
  }
}

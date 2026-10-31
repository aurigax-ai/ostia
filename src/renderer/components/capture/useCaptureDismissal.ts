import { type RefObject, useEffect } from 'react'
import { closeCapture } from '@/lib/capture/captureSession'

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta'])

function inMenu(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="menu"]') !== null
}

export function useCaptureDismissal(
  paneId: string,
  rootRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node && (rootRef.current?.contains(target) ?? false)
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (inMenu(e.target)) return
        if (inside(e.target)) {
          e.preventDefault()
          e.stopPropagation()
        }
        closeCapture(paneId, 'escape')
        return
      }
      if (MODIFIER_KEYS.has(e.key) || e.ctrlKey || e.metaKey) return
      if (!inside(e.target) && !inMenu(e.target)) closeCapture(paneId, 'key')
    }
    const onPointerDown = (e: Event): void => {
      if (!inside(e.target) && !inMenu(e.target)) closeCapture(paneId, 'outside')
    }
    const onScroll = (e: Event): void => {
      if (!inside(e.target) && !inMenu(e.target)) closeCapture(paneId, 'scroll')
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [paneId, rootRef, active])
}

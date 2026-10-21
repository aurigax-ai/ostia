import { type RefObject, useEffect } from 'react'
import { useChatStore } from '@/stores/assist/chatStore'

export function focusAtEnd(area: HTMLTextAreaElement | null): void {
  if (!area) return
  area.focus()
  area.setSelectionRange(area.value.length, area.value.length)
}

function focusIsAround(area: HTMLTextAreaElement | null): boolean {
  const active = document.activeElement
  return !active || active === document.body || (area !== null && active.contains(area))
}

interface ChatFocusParams {
  areaRef: RefObject<HTMLTextAreaElement>
  draftSeed: string | undefined
  setDraft: (draft: string) => void
  chatKey: string
}

export function useChatFocus({
  areaRef,
  draftSeed,
  setDraft,
  chatKey: key,
}: ChatFocusParams): void {
  useEffect(() => {
    focusAtEnd(areaRef.current)
    const frame = requestAnimationFrame(() => {
      if (focusIsAround(areaRef.current) && document.activeElement !== areaRef.current) {
        focusAtEnd(areaRef.current)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [areaRef])

  useEffect(() => {
    if (!draftSeed) return
    setDraft(draftSeed)
    useChatStore.getState().takeDraft(key)
    requestAnimationFrame(() => focusAtEnd(areaRef.current))
  }, [draftSeed, key, setDraft, areaRef])
}

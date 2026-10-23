import { PILL_IDLE_MS } from '@aurigax-ai/ostia-extension-sdk/contract/pillIdle'
import { type FocusEvent, type RefObject, useEffect, useRef, useState } from 'react'

export interface PillIdle {
  ref: RefObject<HTMLDivElement>
  state: 'visible' | 'idle'
  handlers: {
    onPointerEnter: () => void
    onPointerLeave: () => void
    onFocus: () => void
    onBlur: (event: FocusEvent<HTMLElement>) => void
  }
}

export function usePillIdle(held: boolean, activity: number): PillIdle {
  const ref = useRef<HTMLDivElement>(null)
  const [awake, setAwake] = useState(true)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)

  const wakeRef = useRef<() => void>(() => {})

  useEffect(() => {
    const pane = ref.current?.parentElement
    if (!pane) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const wake = (): void => {
      setAwake(true)
      clearTimeout(timer)
      timer = setTimeout(() => setAwake(false), PILL_IDLE_MS)
    }
    wakeRef.current = wake
    wake()
    pane.addEventListener('pointermove', wake)
    pane.addEventListener('pointerdown', wake)
    pane.addEventListener('keydown', wake)
    return () => {
      clearTimeout(timer)
      pane.removeEventListener('pointermove', wake)
      pane.removeEventListener('pointerdown', wake)
      pane.removeEventListener('keydown', wake)
    }
  }, [])

  useEffect(() => {
    if (activity > 0) wakeRef.current()
  }, [activity])

  return {
    ref,
    state: awake || hovered || focused || held ? 'visible' : 'idle',
    handlers: {
      onPointerEnter: () => setHovered(true),
      onPointerLeave: () => setHovered(false),
      onFocus: () => setFocused(true),
      onBlur: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      },
    },
  }
}

import { type RefObject, useEffect, useRef } from 'react'
import { commands } from '@/commands/registry'
import { leavePane } from '@/lib/attention/pointerView'
import { viewPointedPane } from '@/lib/attention/workspaceActivity'
import type { PaneNode } from '@/lib/layout/types'
import { canFocusOnHover, HOVER_FOCUS_DELAY_MS } from '@/lib/terminal/hoverFocus'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { focusSurface } from '@/stores/workspaces/surfaceSlotsStore'

function cellOf(target: EventTarget | null): string | undefined {
  return target instanceof Element
    ? target.closest<HTMLElement>('[data-cell-id]')?.dataset.cellId
    : undefined
}

export function usePaneFrame({
  shown,
  activePaneId,
}: {
  shown: PaneNode
  activePaneId: string
}): RefObject<HTMLDivElement> {
  const frameRef = useRef<HTMLDivElement>(null)
  const focusOnHover = useSettingsStore((s) => s.panes.focusOnHover)
  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !focusOnHover) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let armedFor: string | null = null
    const cancel = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      armedFor = null
    }
    const arm = (e: MouseEvent): void => {
      const target = cellOf(e.target) ?? shown.id
      if (e.buttons !== 0 || target === activePaneId) {
        cancel()
        return
      }
      if (armedFor === target) return
      cancel()
      armedFor = target
      timer = setTimeout(() => {
        timer = null
        armedFor = null
        if (!canFocusOnHover(document)) return
        void commands.exec('pane.focus', { paneId: target })
        requestAnimationFrame(() => focusSurface(target))
      }, HOVER_FOCUS_DELAY_MS)
    }
    frame.addEventListener('mouseenter', arm)
    frame.addEventListener('mousemove', arm)
    frame.addEventListener('mouseleave', cancel)
    frame.addEventListener('mousedown', cancel, true)
    return () => {
      cancel()
      frame.removeEventListener('mouseenter', arm)
      frame.removeEventListener('mousemove', arm)
      frame.removeEventListener('mouseleave', cancel)
      frame.removeEventListener('mousedown', cancel, true)
    }
  }, [focusOnHover, activePaneId, shown.id])
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    let pointed = shown.id
    const point = (e: MouseEvent): void => {
      const target = cellOf(e.target) ?? shown.id
      if (target !== pointed) leavePane(pointed)
      pointed = target
      viewPointedPane(target)
    }
    const leave = (): void => leavePane(pointed)
    frame.addEventListener('mouseenter', point)
    frame.addEventListener('mousemove', point)
    frame.addEventListener('mouseleave', leave)
    return () => {
      leave()
      frame.removeEventListener('mouseenter', point)
      frame.removeEventListener('mousemove', point)
      frame.removeEventListener('mouseleave', leave)
    }
  }, [shown.id])
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const activate = (e: Event): void => {
      const target = cellOf(e.target) ?? shown.id
      if (target !== activePaneId) void commands.exec('pane.focus', { paneId: target })
    }
    frame.addEventListener('mousedown', activate, true)
    frame.addEventListener('focusin', activate)
    return () => {
      frame.removeEventListener('mousedown', activate, true)
      frame.removeEventListener('focusin', activate)
    }
  }, [activePaneId, shown.id])
  return frameRef
}

import { type RefObject, useEffect } from 'react'
import type { PauseTerminal } from './ostiaTerminal'

export const keepDrawing: PauseTerminal = () => {}

export function usePauseWhenHidden(
  pauseRef: RefObject<PauseTerminal>,
  syncSizeRef: RefObject<() => void>,
  shown: boolean,
  paneId: string,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new pane creates a new terminal
  useEffect(() => {
    pauseRef.current?.(!shown)
    if (shown) syncSizeRef.current?.()
  }, [pauseRef, syncSizeRef, shown, paneId])
}

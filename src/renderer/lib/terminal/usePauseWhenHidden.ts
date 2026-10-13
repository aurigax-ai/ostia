import { type RefObject, useEffect } from 'react'
import type { PauseTerminal } from './ostiaTerminal'

export const RELEASE_RENDERER_MS = 10_000

export const keepDrawing: PauseTerminal = () => {}

export function usePauseWhenHidden(
  pauseRef: RefObject<PauseTerminal>,
  shown: boolean,
  paneId: string,
  engine: string,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new pane or engine creates a new terminal
  useEffect(() => {
    const pause = pauseRef.current
    if (!pause) return
    if (shown) {
      pause(false)
      return
    }
    pause(true)
    const release = setTimeout(() => pause(true, { releaseRenderer: true }), RELEASE_RENDERER_MS)
    return () => clearTimeout(release)
  }, [pauseRef, shown, paneId, engine])
}

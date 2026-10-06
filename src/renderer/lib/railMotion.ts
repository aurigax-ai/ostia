import { type AnimationEvent, useEffect, useLayoutEffect, useState } from 'react'
import { useReducedMotion } from './motion'

export type RailMotionPhase = 'opening' | 'closing'

export const RAIL_MOTION_FALLBACK_MS = 600

export const RAIL_KEYFRAMES: Record<RailMotionPhase, string> = {
  opening: 'rail-slide-in',
  closing: 'rail-slide-out',
}

const RESIZING_ATTRIBUTE = 'data-rail-resizing'

interface RailMotionState {
  shownCollapsed: boolean
  phase: RailMotionPhase | null
}

export interface RailMotion extends RailMotionState {
  onAnimationEnd: (e: AnimationEvent<HTMLElement>) => void
}

function settled(s: RailMotionState): RailMotionState {
  if (s.phase === null) return s
  return { shownCollapsed: s.phase === 'closing' ? true : s.shownCollapsed, phase: null }
}

export function nextRailMotion(
  s: RailMotionState,
  collapsed: boolean,
  instant: boolean,
): RailMotionState {
  if (instant) {
    if (s.shownCollapsed === collapsed && s.phase === null) return s
    return { shownCollapsed: collapsed, phase: null }
  }
  if (collapsed) {
    if (s.shownCollapsed || s.phase === 'closing') return s
    return { shownCollapsed: false, phase: 'closing' }
  }
  if (!s.shownCollapsed && s.phase !== 'closing') return s
  return { shownCollapsed: false, phase: 'opening' }
}

export function useRailMotion(collapsed: boolean): RailMotion {
  const reduced = useReducedMotion()
  const [state, setState] = useState<RailMotionState>({
    shownCollapsed: collapsed,
    phase: null,
  })

  useLayoutEffect(() => {
    const instant = reduced || document.documentElement.hasAttribute(RESIZING_ATTRIBUTE)
    setState((s) => nextRailMotion(s, collapsed, instant))
  }, [collapsed, reduced])

  useEffect(() => {
    if (state.phase === null) return
    const timer = window.setTimeout(() => setState(settled), RAIL_MOTION_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [state.phase])

  return {
    ...state,
    onAnimationEnd: (e) => {
      if (e.target !== e.currentTarget) return
      if (state.phase === null || e.animationName !== RAIL_KEYFRAMES[state.phase]) return
      setState(settled)
    },
  }
}

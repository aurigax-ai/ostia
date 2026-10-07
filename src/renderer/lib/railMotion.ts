import { type AnimationEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useReducedMotion } from './motion'

export type RailMotionPhase = 'opening' | 'closing'

export const RAIL_MOTION_FALLBACK_MS = 600

export const RAIL_SLIDE_KEYFRAMES = 'rail-slide'

export const RAIL_MOTION_KEYFRAMES = new Set([
  RAIL_SLIDE_KEYFRAMES,
  'rail-content-fade',
  'rail-follow',
])

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

function railAnimations(): CSSAnimation[] {
  if (typeof document.getAnimations !== 'function') return []
  return document
    .getAnimations()
    .filter(
      (a): a is CSSAnimation =>
        'animationName' in a && RAIL_MOTION_KEYFRAMES.has((a as CSSAnimation).animationName),
    )
}

function slideTiming(): { elapsed: number; duration: number } | null {
  const slide = railAnimations().find((a) => a.animationName === RAIL_SLIDE_KEYFRAMES)
  const duration = slide?.effect?.getComputedTiming().duration
  const elapsed = slide?.currentTime
  if (typeof duration !== 'number' || typeof elapsed !== 'number') return null
  return { elapsed: Math.min(Math.max(elapsed, 0), duration), duration }
}

export function useRailMotion(collapsed: boolean): RailMotion {
  const reduced = useReducedMotion()
  const [state, setState] = useState<RailMotionState>({
    shownCollapsed: collapsed,
    phase: null,
  })
  const current = useRef(state)
  current.current = state
  const mirrorFrom = useRef<{ elapsed: number; duration: number } | null>(null)

  useLayoutEffect(() => {
    const instant = reduced || document.documentElement.hasAttribute(RESIZING_ATTRIBUTE)
    const prev = current.current
    const next = nextRailMotion(prev, collapsed, instant)
    if (prev.phase !== null && next.phase !== null && next.phase !== prev.phase) {
      mirrorFrom.current = slideTiming()
    }
    setState(next)
  }, [collapsed, reduced])

  useLayoutEffect(() => {
    const from = mirrorFrom.current
    mirrorFrom.current = null
    if (from === null || state.phase === null) return
    const mirrored = from.duration - from.elapsed
    for (const a of railAnimations()) a.currentTime = mirrored
  }, [state.phase])

  useEffect(() => {
    if (state.phase === null) return
    const timer = window.setTimeout(() => setState(settled), RAIL_MOTION_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [state.phase])

  return {
    ...state,
    onAnimationEnd: (e) => {
      if (e.target !== e.currentTarget) return
      if (state.phase === null || e.animationName !== RAIL_SLIDE_KEYFRAMES) return
      setState(settled)
    },
  }
}

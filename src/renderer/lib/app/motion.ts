import { motionMode, useSettingsStore } from '@/stores/settingsStore'
import { useEffect, useSyncExternalStore } from 'react'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function useMotionAttribute(): void {
  const motion = useSettingsStore((s) => s.appearance.motion)
  useEffect(() => {
    document.documentElement.dataset.motion = motionMode(motion)
  }, [motion])
}

function subscribeToOsMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function osPrefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

export function useReducedMotion(): boolean {
  const mode = useSettingsStore((s) => motionMode(s.appearance.motion))
  const osReduced = useSyncExternalStore(subscribeToOsMotion, osPrefersReducedMotion)
  return mode === 'reduced' || (mode === 'system' && osReduced)
}

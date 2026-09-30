import { useEffect } from 'react'
import { motionMode, useSettingsStore } from '../stores/settingsStore'

export function useMotionAttribute(): void {
  const motion = useSettingsStore((s) => s.appearance.motion)
  useEffect(() => {
    document.documentElement.dataset.motion = motionMode(motion)
  }, [motion])
}

export function reducedMotion(): boolean {
  const mode = motionMode(useSettingsStore.getState().appearance.motion)
  if (mode !== 'system') return mode === 'reduced'
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

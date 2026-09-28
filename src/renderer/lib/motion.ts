import { useEffect } from 'react'
import { motionMode, useSettingsStore } from '../stores/settingsStore'

export function useMotionAttribute(): void {
  const motion = useSettingsStore((s) => s.appearance.motion)
  useEffect(() => {
    document.documentElement.dataset.motion = motionMode(motion)
  }, [motion])
}

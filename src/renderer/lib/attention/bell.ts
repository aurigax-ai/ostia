import type { BellMode } from '@shared/app/notificationSettings'

export const BELL_SOUND_INTERVAL_MS = 500

export interface BellActions {
  attention: boolean
  sound: boolean
}

export function bellActions(mode: BellMode, viewed: boolean): BellActions {
  if (mode === 'off') return { attention: false, sound: false }
  return { attention: !viewed, sound: mode === 'sound' }
}

export function createBellThrottle(intervalMs = BELL_SOUND_INTERVAL_MS): (now: number) => boolean {
  let last = Number.NEGATIVE_INFINITY
  return (now) => {
    if (now - last < intervalMs) return false
    last = now
    return true
  }
}

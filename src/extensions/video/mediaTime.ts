export function formatClock(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = String(whole % 60).padStart(2, '0')
  if (hours === 0) return `${minutes}:${rest}`
  return `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
}

export function clampTime(seconds: number, duration: number): number {
  const upper = Number.isFinite(duration) && duration > 0 ? duration : 0
  return Math.min(Math.max(seconds, 0), upper)
}

export const PLAYBACK_RATES = [0.5, 1, 1.25, 1.5, 2] as const

export function rateLabel(rate: number): string {
  return `${rate}×`
}

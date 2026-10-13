import {
  PREVIEW_LIMITS,
  type PreviewLimits,
  type PreviewStopReason,
} from '../../shared/artifacts/htmlPreview'

export interface PreviewVitals {
  visible: boolean
  hiddenSince: number | null
  waitingSince: number | null
  memoryBytes: number
  busySince: number | null
}

export type PreviewVerdict =
  | { stop: PreviewStopReason }
  | { stop: null; responding: boolean; busy: boolean }

export function previewVerdict(
  vitals: PreviewVitals,
  now: number,
  limits: PreviewLimits = PREVIEW_LIMITS,
): PreviewVerdict {
  if (vitals.memoryBytes > limits.memoryBytes) return { stop: 'memory' }
  const waited = vitals.waitingSince === null ? 0 : now - vitals.waitingSince
  const responding = waited < limits.notRespondingMs
  if (waited >= limits.stopUnresponsiveMs) return { stop: 'unresponsive' }
  if (!vitals.visible) {
    if (!responding) return { stop: 'unresponsive' }
    const hidden = vitals.hiddenSince === null ? 0 : now - vitals.hiddenSince
    if (hidden >= limits.hiddenMs) return { stop: 'hidden' }
  }
  const busy =
    vitals.visible && vitals.busySince !== null && now - vitals.busySince >= limits.busyMs
  return { stop: null, responding, busy }
}

export function previewsOverCap(
  guests: readonly { id: string; lastShown: number }[],
  max: number = PREVIEW_LIMITS.perWindow,
): string[] {
  if (guests.length <= max) return []
  return [...guests]
    .sort((a, b) => a.lastShown - b.lastShown)
    .slice(0, guests.length - max)
    .map((guest) => guest.id)
}

export function busySince(
  previous: number | null,
  cpuPercent: number,
  visible: boolean,
  now: number,
): number | null {
  if (!visible || cpuPercent < 100) return null
  return previous ?? now
}

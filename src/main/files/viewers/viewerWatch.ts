import { PREVIEW_LIMITS, type PreviewLimits } from '../../../shared/artifacts/htmlPreview'
import type { ViewerStopReason } from '../../../shared/files/filesApi'
import type { ProcessUse } from '../../artifacts/previewHostTypes'
import { previewVerdict } from '../../artifacts/previewLimits'

const MIB = 1024 * 1024
const PING_MS = 1_000
const METRICS_MS = 5_000

export const VIEWER_LIMITS: PreviewLimits = { ...PREVIEW_LIMITS, memoryBytes: 1024 * MIB }

export interface WatchedGuest {
  isDestroyed: () => boolean
  getOSProcessId: () => number
  executeJavaScript: (code: string) => Promise<unknown>
  forcefullyCrashRenderer: () => void
}

interface Watched {
  guest: WatchedGuest
  waitingSince: number | null
  memoryBytes: number
  stop: (reason: ViewerStopReason) => void
}

export interface ViewerWatchDeps {
  processes: () => ProcessUse[]
  now?: () => number
  limits?: PreviewLimits
}

export class ViewerWatch {
  private readonly watched = new Map<string, Watched>()
  private readonly now: () => number
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private metricsTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: ViewerWatchDeps) {
    this.now = deps.now ?? Date.now
  }

  watch(key: string, guest: WatchedGuest, stop: (reason: ViewerStopReason) => void): void {
    this.watched.set(key, { guest, waitingSince: null, memoryBytes: 0, stop })
    this.pingTimer ??= setInterval(() => this.tick(), PING_MS)
    this.metricsTimer ??= setInterval(() => this.measure(), METRICS_MS)
  }

  unwatch(key: string): void {
    this.watched.delete(key)
    if (this.watched.size > 0) return
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.metricsTimer) clearInterval(this.metricsTimer)
    this.pingTimer = null
    this.metricsTimer = null
  }

  unresponsive(key: string): void {
    const entry = this.watched.get(key)
    if (entry && entry.waitingSince === null) entry.waitingSince = this.now()
  }

  tick(): void {
    const now = this.now()
    for (const [key, entry] of [...this.watched]) {
      this.ping(entry, now)
      const verdict = previewVerdict(
        { ...entry, visible: true, hiddenSince: null, busySince: null },
        now,
        this.deps.limits ?? VIEWER_LIMITS,
      )
      if (verdict.stop === 'memory' || verdict.stop === 'unresponsive') {
        this.unwatch(key)
        if (!entry.guest.isDestroyed()) entry.guest.forcefullyCrashRenderer()
        entry.stop(verdict.stop)
      }
    }
  }

  measure(): void {
    const byPid = new Map(this.deps.processes().map((use) => [use.pid, use]))
    for (const entry of this.watched.values()) {
      const guest = entry.guest
      entry.memoryBytes = guest.isDestroyed()
        ? 0
        : (byPid.get(guest.getOSProcessId())?.memoryBytes ?? 0)
    }
  }

  private ping(entry: Watched, now: number): void {
    const guest = entry.guest
    if (guest.isDestroyed() || entry.waitingSince !== null) return
    entry.waitingSince = now
    const answered = (): void => {
      entry.waitingSince = null
    }
    guest.executeJavaScript('0').then(answered, answered)
  }

  dispose(): void {
    for (const key of [...this.watched.keys()]) this.unwatch(key)
  }
}

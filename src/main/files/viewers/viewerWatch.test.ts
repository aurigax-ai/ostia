import { afterEach, describe, expect, it } from 'vitest'
import type { ViewerStopReason } from '../../../shared/types'
import { VIEWER_LIMITS, ViewerWatch, type WatchedGuest } from './viewerWatch'

const MIB = 1024 * 1024

function fakeGuest(pid: number, answers: () => boolean) {
  const guest = {
    crashed: 0,
    isDestroyed: () => false,
    getOSProcessId: () => pid,
    executeJavaScript: () => (answers() ? Promise.resolve(0) : new Promise<unknown>(() => {})),
    forcefullyCrashRenderer: () => {
      guest.crashed++
    },
  }
  return guest satisfies WatchedGuest
}

let watch: ViewerWatch | null = null

afterEach(() => {
  watch?.dispose()
  watch = null
})

function rig(memory: Map<number, number>) {
  const clock = { now: 0 }
  watch = new ViewerWatch({
    processes: () => [...memory].map(([pid, memoryBytes]) => ({ pid, memoryBytes, cpuPercent: 0 })),
    now: () => clock.now,
  })
  return { watch, clock }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('ViewerWatch', () => {
  it('stops a viewer whose process passes the memory limit, and says so', () => {
    const memory = new Map([[7, 100 * MIB]])
    const { watch } = rig(memory)
    const guest = fakeGuest(7, () => true)
    const stops: ViewerStopReason[] = []
    watch.watch('t1', guest, (reason) => stops.push(reason))
    watch.measure()
    watch.tick()
    expect(stops).toEqual([])
    memory.set(7, VIEWER_LIMITS.memoryBytes + MIB)
    watch.measure()
    watch.tick()
    expect(stops).toEqual(['memory'])
    expect(guest.crashed).toBe(1)
    watch.tick()
    expect(stops).toEqual(['memory'])
  })

  it('stops a viewer whose page has not answered for the unresponsive limit', async () => {
    const { watch, clock } = rig(new Map())
    let answering = true
    const guest = fakeGuest(7, () => answering)
    const stops: ViewerStopReason[] = []
    watch.watch('t1', guest, (reason) => stops.push(reason))
    watch.tick()
    await settle()
    answering = false
    clock.now = 1_000
    watch.tick()
    clock.now = 1_000 + VIEWER_LIMITS.stopUnresponsiveMs - 1
    watch.tick()
    expect(stops).toEqual([])
    clock.now = 1_000 + VIEWER_LIMITS.stopUnresponsiveMs
    watch.tick()
    expect(stops).toEqual(['unresponsive'])
    expect(guest.crashed).toBe(1)
  })

  it('never stops a viewer for being hidden or busy, only for memory or no answer', () => {
    const { watch, clock } = rig(new Map([[7, 10 * MIB]]))
    const stops: ViewerStopReason[] = []
    watch.watch(
      't1',
      fakeGuest(7, () => true),
      (reason) => stops.push(reason),
    )
    clock.now = VIEWER_LIMITS.hiddenMs * 10
    watch.measure()
    watch.tick()
    expect(stops).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { coalesced, PUSH_WINDOW_MS } from './panelPush'

function fakeClock() {
  let now = 1_000
  const timers: { at: number; run: () => void }[] = []
  return {
    clock: {
      now: () => now,
      after: (ms: number, run: () => void) => {
        timers.push({ at: now + ms, run })
      },
    },
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers.splice(timers.indexOf(due), 1)
        now = due.at
        due.run()
      }
      now = end
    },
  }
}

describe('coalesced', () => {
  it('pushes the first call at once and folds a burst into one push per window', () => {
    const { clock, advance } = fakeClock()
    const pushes: number[] = []
    const changed = coalesced(() => pushes.push(clock.now()), PUSH_WINDOW_MS, clock)

    changed()
    expect(pushes).toEqual([1_000])

    advance(10)
    for (let i = 0; i < 20; i++) changed()
    expect(pushes).toEqual([1_000])

    advance(PUSH_WINDOW_MS)
    expect(pushes).toEqual([1_000, 1_250])

    advance(PUSH_WINDOW_MS * 4)
    expect(pushes).toEqual([1_000, 1_250])
  })

  it('keeps at least one window between pushes while records keep coming', () => {
    const { clock, advance } = fakeClock()
    const pushes: number[] = []
    const changed = coalesced(() => pushes.push(clock.now()), PUSH_WINDOW_MS, clock)
    for (let i = 0; i < 40; i++) {
      changed()
      advance(50)
    }
    advance(PUSH_WINDOW_MS)
    const gaps = pushes.slice(1).map((at, i) => at - pushes[i])
    expect(gaps.every((gap) => gap >= PUSH_WINDOW_MS)).toBe(true)
    expect(pushes.length).toBeGreaterThanOrEqual(8)
    expect(pushes.length).toBeLessThanOrEqual(9)
  })

  it('pushes a call after a quiet window at once', () => {
    const { clock, advance } = fakeClock()
    const pushes: number[] = []
    const changed = coalesced(() => pushes.push(clock.now()), PUSH_WINDOW_MS, clock)
    changed()
    advance(PUSH_WINDOW_MS + 1)
    changed()
    expect(pushes).toEqual([1_000, 1_251])
  })
})

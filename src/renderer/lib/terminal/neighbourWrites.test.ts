import { describe, expect, it } from 'vitest'
import {
  createNeighbourWrites,
  FOCUS_QUIET_MS,
  FRAME_CHARS,
  type FrameClock,
  MAX_DEFER_MS,
  OVER_BUDGET_MS,
} from './neighbourWrites'

function fakeClock() {
  let time = 1000
  let frames: (() => void)[] = []
  let timers: { at: number; run: () => void }[] = []
  const clock: FrameClock = {
    now: () => time,
    frame: (run) => {
      frames.push(run)
      return () => {
        frames = frames.filter((f) => f !== run)
      }
    },
    timeout: (run, ms) => {
      const timer = { at: time + ms, run }
      timers.push(timer)
      return () => {
        timers = timers.filter((t) => t !== timer)
      }
    },
  }
  return {
    clock,
    frame(advance = 16): void {
      time += advance
      const due = frames
      frames = []
      for (const run of due) run()
    },
    wait(ms: number): void {
      time += ms
      const due = timers.filter((t) => t.at <= time)
      timers = timers.filter((t) => t.at > time)
      for (const timer of due) timer.run()
    },
  }
}

function setup() {
  const fake = fakeClock()
  const writes = createNeighbourWrites(fake.clock)
  const out: { data: string; chunks: number }[] = []
  const queue = writes.queue((data, chunks) => out.push({ data, chunks }))
  return { fake, writes, queue, out }
}

describe('neighbour writes', () => {
  it('joins everything that arrived within a frame into one write, in order', () => {
    const { fake, queue, out } = setup()
    queue.push('a')
    queue.push('b')
    queue.push('c')
    expect(out).toEqual([])
    fake.frame()
    expect(out).toEqual([{ data: 'abc', chunks: 3 }])
  })

  it('drain writes what is queued at once, ahead of whatever the caller writes next', () => {
    const { fake, queue, out } = setup()
    queue.push('one')
    queue.push('two')
    queue.drain()
    expect(out).toEqual([{ data: 'onetwo', chunks: 2 }])
    fake.frame()
    expect(out).toHaveLength(1)
  })

  it('holds neighbour output back while the focused pane is receiving data', () => {
    const { fake, writes, queue, out } = setup()
    writes.noteFocusedWrite()
    queue.push('neighbour')
    fake.frame(FOCUS_QUIET_MS / 2)
    expect(out).toEqual([])
    fake.frame(FOCUS_QUIET_MS)
    expect(out).toEqual([{ data: 'neighbour', chunks: 1 }])
  })

  it('never holds neighbour output past MAX_DEFER_MS however busy the focused pane is', () => {
    const { fake, writes, queue, out } = setup()
    queue.push('neighbour')
    for (let spent = 0; spent < MAX_DEFER_MS; spent += 8) {
      writes.noteFocusedWrite()
      fake.frame(8)
    }
    writes.noteFocusedWrite()
    fake.frame(8)
    expect(out).toEqual([{ data: 'neighbour', chunks: 1 }])
  })

  it('still writes when no frame ever runs, as in a hidden window', () => {
    const { fake, writes, queue, out } = setup()
    writes.noteFocusedWrite()
    queue.push('neighbour')
    fake.wait(MAX_DEFER_MS)
    expect(out).toEqual([{ data: 'neighbour', chunks: 1 }])
  })

  it('writes at most FRAME_CHARS per frame and loses nothing', () => {
    const { fake, queue, out } = setup()
    const chunk = 'x'.repeat(FRAME_CHARS / 2)
    for (let i = 0; i < 6; i++) queue.push(chunk)
    fake.frame()
    expect(out).toHaveLength(1)
    expect(out[0].data.length).toBe(FRAME_CHARS)
    for (let i = 0; i < 6; i++) fake.frame()
    expect(out.map((w) => w.data).join('')).toBe(chunk.repeat(6))
  })

  it('holds neighbour output back for a while after a frame ran long', () => {
    const { fake, queue, out } = setup()
    const chunk = 'x'.repeat(FRAME_CHARS)
    for (let i = 0; i < 3; i++) queue.push(chunk)
    fake.frame()
    expect(out).toHaveLength(1)
    fake.frame(OVER_BUDGET_MS + 10)
    fake.frame(16)
    fake.frame(16)
    expect(out).toHaveLength(1)
    fake.frame(16)
    expect(out).toHaveLength(2)
  })

  it('drops queued output once disposed', () => {
    const { fake, queue, out } = setup()
    queue.push('late')
    queue.dispose()
    fake.frame()
    fake.wait(MAX_DEFER_MS)
    expect(out).toEqual([])
  })
})

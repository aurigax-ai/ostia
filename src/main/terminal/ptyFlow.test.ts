import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CoalescedOutput,
  FLOW_HIGH_WATERMARK,
  FLOW_LOW_WATERMARK,
  FLOW_STALL_MS,
  PtyFlowControl,
} from './ptyFlow'

function fakePty() {
  const calls: string[] = []
  return {
    calls,
    target: { pause: () => calls.push('pause'), resume: () => calls.push('resume') },
  }
}

const shown = () => true

afterEach(() => {
  vi.useRealTimers()
})

describe('CoalescedOutput', () => {
  it('sends one message for every chunk pushed in the same turn', async () => {
    const sent: string[] = []
    const out = new CoalescedOutput((data) => sent.push(data))
    for (let i = 0; i < 500; i++) out.push(`line ${i}\n`)
    expect(sent).toEqual([])
    await new Promise((resolve) => setImmediate(resolve))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toBe(Array.from({ length: 500 }, (_, i) => `line ${i}\n`).join(''))
  })

  it('delivers what is queued at once on flush, keeping order', async () => {
    const sent: string[] = []
    const out = new CoalescedOutput((data) => sent.push(data))
    out.push('a')
    out.push('b')
    out.flush()
    out.push('c')
    await new Promise((resolve) => setImmediate(resolve))
    expect(sent).toEqual(['ab', 'c'])
  })

  it('drops queued output and ignores later pushes once closed', async () => {
    const sent: string[] = []
    const out = new CoalescedOutput((data) => sent.push(data))
    out.push('a')
    out.close()
    out.push('b')
    await new Promise((resolve) => setImmediate(resolve))
    expect(sent).toEqual([])
  })
})

describe('PtyFlowControl', () => {
  it('pauses above the high watermark and resumes once acknowledged below the low one', () => {
    const pty = fakePty()
    const flow = new PtyFlowControl(pty.target)
    const lane = flow.open('w1', shown)
    lane.sent(FLOW_HIGH_WATERMARK)
    expect(pty.calls).toEqual([])
    lane.sent(1)
    expect(pty.calls).toEqual(['pause'])
    lane.sent(10)
    expect(pty.calls).toEqual(['pause'])
    flow.ack('w1', FLOW_HIGH_WATERMARK + 11 - FLOW_LOW_WATERMARK - 1)
    expect(pty.calls).toEqual(['pause'])
    flow.ack('w1', 2)
    expect(pty.calls).toEqual(['pause', 'resume'])
    expect(flow.isPaused).toBe(false)
    flow.dispose()
  })

  it('resumes a paused pty when the renderer that held it detaches', () => {
    const pty = fakePty()
    const flow = new PtyFlowControl(pty.target)
    const lane = flow.open('w1', shown)
    lane.sent(FLOW_HIGH_WATERMARK + 1)
    lane.close()
    expect(pty.calls).toEqual(['pause', 'resume'])
    lane.sent(FLOW_HIGH_WATERMARK + 1)
    expect(pty.calls).toEqual(['pause', 'resume'])
  })

  it('resumes when a crashed renderer is released and stops counting what it is still sent', () => {
    const pty = fakePty()
    const flow = new PtyFlowControl(pty.target)
    const lane = flow.open('w1', shown)
    lane.sent(FLOW_HIGH_WATERMARK + 1)
    flow.release('w1')
    expect(pty.calls).toEqual(['pause', 'resume'])
    lane.sent(FLOW_HIGH_WATERMARK * 3)
    expect(flow.isPaused).toBe(false)
  })

  it('a re-attach replaces the lane, so the old one closing later does not drop the new one', () => {
    const pty = fakePty()
    const flow = new PtyFlowControl(pty.target)
    const old = flow.open('w1', shown)
    old.sent(FLOW_HIGH_WATERMARK + 1)
    const fresh = flow.open('w1', shown)
    expect(pty.calls).toEqual(['pause', 'resume'])
    old.close()
    fresh.sent(FLOW_HIGH_WATERMARK + 1)
    expect(pty.calls).toEqual(['pause', 'resume', 'pause'])
    flow.dispose()
  })

  it('only pauses for a lane over the high watermark and waits for every lane to drain', () => {
    const pty = fakePty()
    const flow = new PtyFlowControl(pty.target)
    const a = flow.open('a', shown)
    const b = flow.open('b', shown)
    a.sent(FLOW_HIGH_WATERMARK + 1)
    b.sent(FLOW_HIGH_WATERMARK)
    flow.ack('a', FLOW_HIGH_WATERMARK + 1)
    expect(pty.calls).toEqual(['pause'])
    flow.ack('b', FLOW_HIGH_WATERMARK)
    expect(pty.calls).toEqual(['pause', 'resume'])
    flow.dispose()
  })

  it('ignores acknowledgements from unknown senders and non-positive counts', () => {
    const pty = fakePty()
    const flow = new PtyFlowControl(pty.target)
    const lane = flow.open('w1', shown)
    lane.sent(FLOW_HIGH_WATERMARK + 1)
    flow.ack('w2', FLOW_HIGH_WATERMARK)
    flow.ack('w1', -FLOW_HIGH_WATERMARK)
    flow.ack('w1', Number.NaN)
    expect(pty.calls).toEqual(['pause'])
    flow.dispose()
  })

  it('resumes a pty whose renderer stopped acknowledging (hidden or hung window)', () => {
    vi.useFakeTimers()
    const pty = fakePty()
    const flow = new PtyFlowControl(pty.target)
    const lane = flow.open('w1', shown)
    lane.sent(FLOW_HIGH_WATERMARK + 1)
    vi.advanceTimersByTime(FLOW_STALL_MS - 1)
    flow.ack('w1', 1)
    vi.advanceTimersByTime(FLOW_STALL_MS - 1)
    expect(pty.calls).toEqual(['pause'])
    vi.advanceTimersByTime(1)
    expect(pty.calls).toEqual(['pause', 'resume'])
    lane.sent(FLOW_HIGH_WATERMARK)
    expect(pty.calls).toEqual(['pause', 'resume'])
    flow.dispose()
  })

  it('never touches the pty after dispose', () => {
    vi.useFakeTimers()
    const pty = fakePty()
    const flow = new PtyFlowControl(pty.target)
    flow.open('w1', shown).sent(FLOW_HIGH_WATERMARK + 1)
    flow.dispose()
    vi.advanceTimersByTime(FLOW_STALL_MS * 2)
    expect(pty.calls).toEqual(['pause'])
  })

  it('never pauses for a hidden window, however much it has not acknowledged', () => {
    const pty = fakePty()
    const flow = new PtyFlowControl(pty.target)
    let visible = false
    const lane = flow.open('w1', () => visible)
    lane.sent(FLOW_HIGH_WATERMARK * 10)
    expect(pty.calls).toEqual([])
    visible = true
    lane.sent(FLOW_HIGH_WATERMARK)
    expect(pty.calls).toEqual([])
    lane.sent(1)
    expect(pty.calls).toEqual(['pause'])
    flow.dispose()
  })

  it('resumes a paused pty at once when its window is hidden or minimized', () => {
    const pty = fakePty()
    const flow = new PtyFlowControl(pty.target)
    let visible = true
    const lane = flow.open('w1', () => visible)
    lane.sent(FLOW_HIGH_WATERMARK + 1)
    visible = false
    flow.hidden('w1')
    expect(pty.calls).toEqual(['pause', 'resume'])
    lane.sent(FLOW_HIGH_WATERMARK * 10)
    expect(pty.calls).toEqual(['pause', 'resume'])
    flow.dispose()
  })
})

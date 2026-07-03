import { describe, expect, it } from 'vitest'
import { PtyRingBuffer } from './ptyRingBuffer'

describe('PtyRingBuffer', () => {
  it('replays everything from cursor 0 and reports the end position', () => {
    const rb = new PtyRingBuffer(1000)
    rb.push('hello ')
    rb.push('world')
    expect(rb.end).toBe(11)
    expect(rb.since(0)).toEqual({ data: 'hello world', cursor: 11, dropped: false })
  })

  it('returns only new bytes since a cursor', () => {
    const rb = new PtyRingBuffer(1000)
    rb.push('abc')
    const a = rb.since(0)
    rb.push('def')
    expect(rb.since(a.cursor)).toEqual({ data: 'def', cursor: 6, dropped: false })
  })

  it('trims at a newline boundary when over cap, marking dropped for stale cursors', () => {
    const rb = new PtyRingBuffer(8)
    // 'aaaa\nbbbb\ncccc' is 14 bytes (brief's comment said 13 — off by one) > cap 8
    rb.push('aaaa\nbbbb\ncccc')
    // retained window starts after a safe boundary; a cursor of 0 is now stale
    const r = rb.since(0)
    expect(r.dropped).toBe(true)
    expect(r.cursor).toBe(14)
    // retained data ends at the stream end and never starts mid-line
    expect('aaaa\nbbbb\ncccc'.endsWith(r.data)).toBe(true)
    expect(r.data.startsWith('cccc') || r.data.startsWith('bbbb')).toBe(true)
  })

  it('trims to the ESC boundary so a replayed CSI is never cut mid-sequence', () => {
    const rb = new PtyRingBuffer(7)
    rb.push('xy\x1b[31mZ') // 8 bytes > cap 7; naive cut = 8-7 = 1, which falls short of the
    // ESC at index 2 — the `cut = esc` branch must advance the cut to 2 so the retained
    // window starts exactly at the ESC. Without that branch, cut stays at 1 and the
    // retained data would be 'y\x1b[31mZ' instead, failing the assertions below.
    const { data } = rb.since(0)
    expect(data).toBe('\x1b[31mZ')
    expect(data[0]).toBe('\x1b')
  })
})

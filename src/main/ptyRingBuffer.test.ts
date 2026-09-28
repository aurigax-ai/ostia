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
    rb.push('aaaa\nbbbb\ncccc')
    const r = rb.since(0)
    expect(r.dropped).toBe(true)
    expect(r.cursor).toBe(14)
    expect('aaaa\nbbbb\ncccc'.endsWith(r.data)).toBe(true)
    expect(r.data.startsWith('cccc') || r.data.startsWith('bbbb')).toBe(true)
  })

  it('trims to the ESC boundary so a replayed CSI is never cut mid-sequence', () => {
    const rb = new PtyRingBuffer(7)
    rb.push('xy\x1b[31mZ')
    const { data } = rb.since(0)
    expect(data).toBe('\x1b[31mZ')
    expect(data[0]).toBe('\x1b')
  })
})

import { describe, expect, it } from 'vitest'
import { PREVIEW_LIMITS } from '../../shared/artifacts/htmlPreview'
import { type PreviewVitals, busySince, previewVerdict, previewsOverCap } from './previewLimits'

const MIB = 1024 * 1024

const shown: PreviewVitals = {
  visible: true,
  hiddenSince: null,
  waitingSince: null,
  memoryBytes: 80 * MIB,
  busySince: null,
}

describe('previewVerdict', () => {
  it('uses the approved limits', () => {
    expect(PREVIEW_LIMITS).toMatchObject({
      notRespondingMs: 5_000,
      stopUnresponsiveMs: 15_000,
      memoryBytes: 512 * MIB,
      hiddenMs: 60_000,
      perWindow: 4,
    })
  })

  it('leaves a healthy visible page alone', () => {
    expect(previewVerdict(shown, 1_000)).toEqual({ stop: null, responding: true, busy: false })
  })

  it('says a page is not responding after 5 s and stops it after 15 s', () => {
    const stuck = { ...shown, waitingSince: 10_000 }
    expect(previewVerdict(stuck, 14_999)).toEqual({ stop: null, responding: true, busy: false })
    expect(previewVerdict(stuck, 15_000)).toEqual({ stop: null, responding: false, busy: false })
    expect(previewVerdict(stuck, 24_999)).toEqual({ stop: null, responding: false, busy: false })
    expect(previewVerdict(stuck, 25_000)).toEqual({ stop: 'unresponsive' })
  })

  it('stops a page over 512 MiB, at the limit not yet', () => {
    expect(previewVerdict({ ...shown, memoryBytes: 512 * MIB }, 0).stop).toBeNull()
    expect(previewVerdict({ ...shown, memoryBytes: 512 * MIB + 1 }, 0)).toEqual({ stop: 'memory' })
  })

  it('destroys a hidden page after 60 s, and at once when it stops responding', () => {
    const hidden = { ...shown, visible: false, hiddenSince: 1_000 }
    expect(previewVerdict(hidden, 60_999).stop).toBeNull()
    expect(previewVerdict(hidden, 61_000)).toEqual({ stop: 'hidden' })
    expect(previewVerdict({ ...hidden, waitingSince: 2_000 }, 7_000)).toEqual({
      stop: 'unresponsive',
    })
  })

  it('never stops a visible page for being hidden earlier', () => {
    expect(previewVerdict({ ...shown, hiddenSince: null }, 10_000_000).stop).toBeNull()
  })

  it('offers Stop for a visible page that kept a core busy for 30 s, and never kills it', () => {
    const busy = { ...shown, busySince: 0 }
    expect(previewVerdict(busy, 29_999)).toEqual({ stop: null, responding: true, busy: false })
    expect(previewVerdict(busy, 30_000)).toEqual({ stop: null, responding: true, busy: true })
    expect(previewVerdict(busy, 3_600_000)).toEqual({ stop: null, responding: true, busy: true })
  })
})

describe('busySince', () => {
  it('starts when a visible page uses a full core and resets when it does not', () => {
    expect(busySince(null, 120, true, 500)).toBe(500)
    expect(busySince(500, 100, true, 900)).toBe(500)
    expect(busySince(500, 99, true, 900)).toBeNull()
    expect(busySince(500, 400, false, 900)).toBeNull()
  })
})

describe('previewsOverCap', () => {
  it('names nobody up to four previews', () => {
    const four = [1, 2, 3, 4].map((n) => ({ id: `p${n}`, lastShown: n }))
    expect(previewsOverCap(four)).toEqual([])
  })

  it('names the least recently shown beyond four', () => {
    const guests = [
      { id: 'a', lastShown: 50 },
      { id: 'b', lastShown: 10 },
      { id: 'c', lastShown: 40 },
      { id: 'd', lastShown: 20 },
      { id: 'e', lastShown: 60 },
      { id: 'f', lastShown: 30 },
    ]
    expect(previewsOverCap(guests)).toEqual(['b', 'd'])
  })
})

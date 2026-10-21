import { describe, expect, it } from 'vitest'
import { captureFactor, scaledRegion, scaledSize } from './frameScale'

describe('captureFactor', () => {
  it('keeps native resolution up to the long side limit', () => {
    expect(captureFactor({ width: 3840, height: 2160 })).toBe(1)
    expect(captureFactor({ width: 4096, height: 4096 })).toBe(1)
  })

  it('shrinks an 8K frame to fit the limit', () => {
    expect(captureFactor({ width: 7680, height: 4320 })).toBeCloseTo(4096 / 7680)
  })

  it('measures the long side, portrait or landscape', () => {
    expect(captureFactor({ width: 2160, height: 8192 })).toBe(0.5)
    expect(captureFactor({ width: 8192, height: 2160 })).toBe(0.5)
  })

  it('takes a custom limit', () => {
    expect(captureFactor({ width: 1000, height: 500 }, 250)).toBe(0.25)
  })
})

describe('scaledSize', () => {
  it('rounds and never reaches zero', () => {
    expect(scaledSize({ width: 7680, height: 4320 }, 4096 / 7680)).toEqual({
      width: 4096,
      height: 2304,
    })
    expect(scaledSize({ width: 3, height: 1 }, 0.1)).toEqual({ width: 1, height: 1 })
  })
})

describe('scaledRegion', () => {
  const frame = { width: 4096, height: 2304 }

  it('scales a region into the scaled frame', () => {
    expect(
      scaledRegion({ x: 3840, y: 2160, width: 3840, height: 2160 }, 4096 / 7680, frame),
    ).toEqual({
      x: 2048,
      y: 1152,
      width: 2048,
      height: 1152,
    })
  })

  it('never leaves the scaled frame', () => {
    const region = scaledRegion({ x: 7000, y: 4000, width: 680, height: 320 }, 4096 / 7680, frame)
    expect(region.x + region.width).toBeLessThanOrEqual(frame.width)
    expect(region.y + region.height).toBeLessThanOrEqual(frame.height)
  })

  it('is unchanged at native scale', () => {
    expect(
      scaledRegion({ x: 10, y: 20, width: 30, height: 40 }, 1, { width: 100, height: 100 }),
    ).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    })
  })
})

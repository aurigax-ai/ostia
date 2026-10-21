import { describe, expect, it, vi } from 'vitest'
import {
  CAPTURE_ATTEMPTS,
  CAPTURE_LONG_SIDE_MAX,
  captureScale,
  encodeWithin,
  scaledSize,
} from './imageCapture'

describe('captureScale', () => {
  it('keeps a region at native resolution up to the long-side cap', () => {
    expect(captureScale({ width: 4096, height: 100 })).toBe(1)
    expect(captureScale({ width: 640, height: 360 })).toBe(1)
  })

  it('shrinks a larger region so its long side is the cap', () => {
    expect(captureScale({ width: 8192, height: 4096 })).toBe(0.5)
    expect(captureScale({ width: 1000, height: 5000 })).toBe(CAPTURE_LONG_SIDE_MAX / 5000)
  })
})

describe('scaledSize', () => {
  it('rounds and never reaches zero', () => {
    expect(scaledSize({ width: 5000, height: 3000 }, 4096 / 5000)).toEqual({
      width: 4096,
      height: 2458,
    })
    expect(scaledSize({ width: 3, height: 1 }, 0.1)).toEqual({ width: 1, height: 1 })
  })
})

describe('encodeWithin', () => {
  it('encodes a small region at its own size', async () => {
    const encode = vi.fn(async (output) => ({ size: 100, output }))
    const result = await encodeWithin({ width: 200, height: 100 }, 1000, encode)
    expect(result?.output).toEqual({ width: 200, height: 100 })
    expect(encode).toHaveBeenCalledTimes(1)
  })

  it('starts a big photo at the cap and halves until the PNG fits', async () => {
    const sizes: number[] = []
    const result = await encodeWithin({ width: 8000, height: 6000 }, 1100, async (output) => {
      sizes.push(output.width)
      return { size: output.width, output }
    })
    expect(sizes).toEqual([4096, 2048, 1024])
    expect(result?.output.width).toBe(1024)
  })

  it('treats an encoder that fails as too big, and gives up after the attempts', async () => {
    const encode = vi.fn(async () => null)
    expect(await encodeWithin({ width: 10, height: 10 }, 1000, encode)).toBeNull()
    expect(encode).toHaveBeenCalledTimes(CAPTURE_ATTEMPTS)
  })
})

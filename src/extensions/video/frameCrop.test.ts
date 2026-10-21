import { describe, expect, it } from 'vitest'
import { dragBox, fitBox, nativeRegion } from './frameCrop'

describe('fitBox', () => {
  it('letterboxes a wide picture in a tall page', () => {
    expect(fitBox({ width: 400, height: 400 }, { width: 640, height: 360 })).toEqual({
      x: 0,
      y: 87.5,
      width: 400,
      height: 225,
    })
  })

  it('pillarboxes a tall picture in a wide page', () => {
    expect(fitBox({ width: 400, height: 200 }, { width: 100, height: 200 })).toEqual({
      x: 150,
      y: 0,
      width: 100,
      height: 200,
    })
  })

  it('is empty without sizes', () => {
    expect(fitBox({ width: 400, height: 200 }, { width: 0, height: 0 }).width).toBe(0)
    expect(fitBox({ width: 0, height: 0 }, { width: 10, height: 10 }).height).toBe(0)
  })
})

describe('dragBox', () => {
  const shown = { x: 0, y: 100, width: 400, height: 200 }

  it('orders the corners and clips to the picture', () => {
    expect(dragBox({ x: 300, y: 250 }, { x: -50, y: 50 }, shown)).toEqual({
      x: 0,
      y: 100,
      width: 300,
      height: 150,
    })
  })

  it('refuses a rectangle that is too small', () => {
    expect(dragBox({ x: 10, y: 120 }, { x: 12, y: 300 }, shown)).toBeNull()
    expect(dragBox({ x: 10, y: 500 }, { x: 90, y: 600 }, shown)).toBeNull()
  })
})

describe('nativeRegion', () => {
  const media = { width: 640, height: 360 }
  const shown = { x: 0, y: 87.5, width: 320, height: 180 }

  it('scales the selection to the native pixels', () => {
    expect(nativeRegion({ x: 80, y: 87.5 + 45, width: 160, height: 90 }, shown, media)).toEqual({
      x: 160,
      y: 90,
      width: 320,
      height: 180,
    })
  })

  it('covers the whole picture for the whole shown box', () => {
    expect(nativeRegion(shown, shown, media)).toEqual({ x: 0, y: 0, width: 640, height: 360 })
  })

  it('is null when nothing is shown', () => {
    expect(nativeRegion(shown, { x: 0, y: 0, width: 0, height: 0 }, media)).toBeNull()
  })
})

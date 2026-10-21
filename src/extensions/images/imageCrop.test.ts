import { describe, expect, it } from 'vitest'
import { cropRect, dragRegion, pageRect } from './imageCrop'

const NATURAL = { width: 640, height: 360 }

describe('dragRegion', () => {
  it('takes the corners in any order and snaps outward to whole pixels', () => {
    expect(dragRegion({ x: 100.4, y: 50.2 }, { x: 20.6, y: 10.1 }, NATURAL)).toEqual({
      x: 20,
      y: 10,
      width: 81,
      height: 41,
    })
  })

  it('clamps to the image', () => {
    expect(dragRegion({ x: -30, y: -30 }, { x: 900, y: 900 }, NATURAL)).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 360,
    })
  })

  it('is null for a click or a sliver', () => {
    expect(dragRegion({ x: 10, y: 10 }, { x: 10, y: 10 }, NATURAL)).toBeNull()
    expect(dragRegion({ x: 10, y: 10 }, { x: 10.5, y: 200 }, NATURAL)).toBeNull()
  })
})

describe('cropRect', () => {
  it('is the whole image without a region', () => {
    expect(cropRect(null, NATURAL)).toEqual({ x: 0, y: 0, width: 640, height: 360 })
    const region = { x: 1, y: 2, width: 3, height: 4 }
    expect(cropRect(region, NATURAL)).toBe(region)
  })
})

describe('pageRect', () => {
  const viewport = { width: 800, height: 600 }

  it('places a region in page pixels at the zoom', () => {
    const region = { x: 100, y: 50, width: 200, height: 100 }
    expect(pageRect(region, NATURAL, { left: 40, top: 30 }, 0.5, viewport)).toEqual({
      x: 90,
      y: 55,
      width: 100,
      height: 50,
    })
  })

  it('keeps only the part of the whole image that is on screen', () => {
    expect(pageRect(null, NATURAL, { left: -100, top: 20 }, 2, viewport)).toEqual({
      x: 0,
      y: 20,
      width: 800,
      height: 580,
    })
  })

  it('is null when nothing of the region is on screen', () => {
    const region = { x: 0, y: 0, width: 10, height: 10 }
    expect(pageRect(region, NATURAL, { left: -500, top: 0 }, 1, viewport)).toBeNull()
  })
})

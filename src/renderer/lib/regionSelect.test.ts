import { describe, expect, it } from 'vitest'
import {
  ZOOM_STEPS,
  dragRegion,
  fitScale,
  fitWidthScale,
  pixelRect,
  scaleRegion,
  stepZoom,
  toContentPoint,
} from './regionSelect'

describe('toContentPoint', () => {
  it('maps a client point into unscaled content coordinates', () => {
    expect(toContentPoint({ x: 150, y: 90 }, { left: 50, top: 10 }, 2)).toEqual({ x: 50, y: 40 })
  })

  it('treats a non-positive scale as 1', () => {
    expect(toContentPoint({ x: 5, y: 6 }, { left: 0, top: 0 }, 0)).toEqual({ x: 5, y: 6 })
  })
})

describe('dragRegion', () => {
  const bounds = { width: 200, height: 100 }

  it('normalizes a drag in any direction into a whole-pixel region', () => {
    expect(dragRegion({ x: 120.6, y: 80.2 }, { x: 20.4, y: 10.9 }, bounds)).toEqual({
      x: 20,
      y: 10,
      width: 101,
      height: 71,
    })
  })

  it('clamps a drag that leaves the content to its edges', () => {
    expect(dragRegion({ x: -30, y: -5 }, { x: 500, y: 40 }, bounds)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 40,
    })
  })

  it('returns null for a click or a sliver', () => {
    expect(dragRegion({ x: 10, y: 10 }, { x: 10, y: 10 }, bounds)).toBeNull()
    expect(dragRegion({ x: 10, y: 10 }, { x: 60, y: 11 }, bounds)).toBeNull()
  })

  it('returns null when the whole drag is outside the content', () => {
    expect(dragRegion({ x: 300, y: 10 }, { x: 400, y: 50 }, bounds)).toBeNull()
  })
})

describe('scaleRegion', () => {
  it('converts rendered pixels to page points at the render scale', () => {
    expect(scaleRegion({ x: 150, y: 300, width: 75, height: 30 }, 1 / 1.5)).toEqual({
      x: 100,
      y: 200,
      width: 50,
      height: 20,
    })
  })
})

describe('pixelRect', () => {
  it('scales a region to device pixels and keeps it inside the canvas', () => {
    expect(
      pixelRect({ x: 10, y: 20, width: 30, height: 40 }, 2, { width: 100, height: 70 }),
    ).toEqual({ x: 20, y: 40, width: 60, height: 30 })
  })

  it('never returns an empty rectangle', () => {
    const r = pixelRect({ x: 99.9, y: 0, width: 0.01, height: 0.01 }, 1, { width: 100, height: 50 })
    expect(r.width).toBeGreaterThanOrEqual(1)
    expect(r.height).toBeGreaterThanOrEqual(1)
    expect(r.x + r.width).toBeLessThanOrEqual(100)
  })
})

describe('fitScale', () => {
  it('shrinks large content to fit and never enlarges small content', () => {
    expect(fitScale({ width: 2000, height: 1000 }, { width: 1000, height: 1000 })).toBe(0.5)
    expect(fitScale({ width: 100, height: 50 }, { width: 1000, height: 1000 })).toBe(1)
  })

  it('leaves room for padding and ignores a zero-size stage', () => {
    expect(fitScale({ width: 100, height: 100 }, { width: 70, height: 500 }, 10)).toBe(0.5)
    expect(fitScale({ width: 100, height: 100 }, { width: 0, height: 0 })).toBe(1)
  })
})

describe('fitWidthScale', () => {
  it('scales content to the stage width, up or down', () => {
    expect(fitWidthScale({ width: 612, height: 792 }, { width: 1244, height: 10 }, 10)).toBe(2)
    expect(fitWidthScale({ width: 612, height: 792 }, { width: 0, height: 10 })).toBe(1)
  })
})

describe('stepZoom', () => {
  it('moves to the next zoom step in either direction', () => {
    expect(stepZoom(1, 1)).toBe(1.25)
    expect(stepZoom(1, -1)).toBe(0.75)
    expect(stepZoom(0.6, 1)).toBe(0.75)
    expect(stepZoom(0.6, -1)).toBe(0.5)
  })

  it('stops at the ends of the scale', () => {
    expect(stepZoom(ZOOM_STEPS[0], -1)).toBe(ZOOM_STEPS[0])
    expect(stepZoom(8, 1)).toBe(8)
  })
})

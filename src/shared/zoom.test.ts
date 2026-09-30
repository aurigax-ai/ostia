import { describe, expect, it } from 'vitest'
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, clampZoom, stepZoom, zoomFactor } from './zoom'

describe('clampZoom', () => {
  it('keeps values inside 80 to 150 and rounds to a whole percent', () => {
    expect(clampZoom(10)).toBe(ZOOM_MIN)
    expect(clampZoom(400)).toBe(ZOOM_MAX)
    expect(clampZoom(112.6)).toBe(113)
  })

  it('falls back to 100 for anything that is not a finite number', () => {
    expect(clampZoom('120')).toBe(ZOOM_DEFAULT)
    expect(clampZoom(Number.NaN)).toBe(ZOOM_DEFAULT)
    expect(clampZoom(undefined)).toBe(ZOOM_DEFAULT)
  })
})

describe('stepZoom', () => {
  it('moves in 10 point steps and stops at the limits', () => {
    expect(stepZoom(100, 1)).toBe(110)
    expect(stepZoom(100, -1)).toBe(90)
    expect(stepZoom(150, 1)).toBe(150)
    expect(stepZoom(80, -1)).toBe(80)
  })

  it('snaps an off-grid value to the grid before stepping', () => {
    expect(stepZoom(113, 1)).toBe(120)
    expect(stepZoom(113, -1)).toBe(100)
  })
})

describe('zoomFactor', () => {
  it('converts percent to an Electron zoom factor within range', () => {
    expect(zoomFactor(125)).toBe(1.25)
    expect(zoomFactor(500)).toBe(1.5)
    expect(zoomFactor(0)).toBe(0.8)
  })
})

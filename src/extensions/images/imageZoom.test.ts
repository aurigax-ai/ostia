import { describe, expect, it } from 'vitest'
import {
  anchoredScroll,
  fitScale,
  formatPercent,
  menuPercent,
  pinchZoom,
  scaleOf,
  stepZoom,
  toContentPoint,
  ZOOM_MENU_PERCENTS,
  ZOOM_STEPS,
  zoomPercent,
} from './imageZoom'

describe('fitScale', () => {
  it('shrinks to the pane minus the padding and never enlarges', () => {
    expect(fitScale({ width: 1000, height: 500 }, { width: 532, height: 400 }, 16)).toBe(0.5)
    expect(fitScale({ width: 100, height: 50 }, { width: 800, height: 600 }, 16)).toBe(1)
  })

  it('answers 1 for an empty image or a pane with no room', () => {
    expect(fitScale({ width: 0, height: 10 }, { width: 800, height: 600 }, 16)).toBe(1)
    expect(fitScale({ width: 10, height: 10 }, { width: 20, height: 600 }, 16)).toBe(1)
  })
})

describe('scaleOf', () => {
  const content = { width: 1000, height: 1000 }
  const stage = { width: 532, height: 532 }

  it('fits in fit mode and passes a number through', () => {
    expect(scaleOf('fit', content, stage)).toBe(0.5)
    expect(scaleOf(2, content, stage)).toBe(2)
  })
})

describe('stepZoom', () => {
  it('moves to the next step in each direction', () => {
    expect(stepZoom(1, 1)).toBe(1.25)
    expect(stepZoom(1, -1)).toBe(0.75)
    expect(stepZoom(0.6, 1)).toBe(0.75)
    expect(stepZoom(0.6, -1)).toBe(0.5)
  })

  it('stops at the ends', () => {
    expect(stepZoom(8, 1)).toBe(8)
    expect(stepZoom(0.1, -1)).toBe(0.1)
    expect(stepZoom(20, 1)).toBe(8)
  })
})

describe('pinchZoom', () => {
  it('zooms in on a negative delta and out on a positive one', () => {
    expect(pinchZoom(1, -10)).toBeGreaterThan(1)
    expect(pinchZoom(1, 10)).toBeLessThan(1)
  })

  it('stays inside the zoom range and caps one event', () => {
    expect(pinchZoom(8, -50)).toBe(8)
    expect(pinchZoom(0.1, 50)).toBe(0.1)
    expect(pinchZoom(1, -5000)).toBe(pinchZoom(1, -50))
  })
})

describe('the zoom menu', () => {
  it('lists 50 to 400 percent', () => {
    expect([...ZOOM_MENU_PERCENTS]).toEqual([50, 75, 100, 125, 150, 200, 300, 400])
    expect(ZOOM_STEPS).toContain(0.5)
  })

  it('checks a listed percent and none for another', () => {
    expect(menuPercent(1)).toBe(100)
    expect(menuPercent(0.5)).toBe(50)
    expect(menuPercent(1.004)).toBe(100)
    expect(menuPercent(0.37)).toBeNull()
    expect(menuPercent(8)).toBeNull()
  })

  it('rounds the percent and formats it for the locale', () => {
    expect(zoomPercent(0.3333)).toBe(33)
    expect(formatPercent(125, 'en')).toBe('125%')
  })
})

describe('anchored zoom', () => {
  it('maps a pointer to the image point under it', () => {
    expect(toContentPoint({ x: 150, y: 90 }, { left: 50, top: 10 }, 2)).toEqual({ x: 50, y: 40 })
    expect(toContentPoint({ x: 10, y: 10 }, { left: 0, top: 0 }, 0)).toEqual({ x: 10, y: 10 })
  })

  it('scrolls so the anchored point stays under the pointer', () => {
    const anchor = { content: { x: 50, y: 40 }, client: { x: 150, y: 90 } }
    const next = anchoredScroll({ x: 0, y: 0 }, anchor, { left: 50, top: 10 }, 4)
    expect(next).toEqual({ x: 100, y: 80 })
  })
})

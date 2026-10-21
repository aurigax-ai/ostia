import { describe, expect, it } from 'vitest'
import {
  clampScale,
  currentPage,
  fitPageScale,
  fitWidthScale,
  MAX_CANVAS_PIXELS,
  modeChoice,
  modeOfChoice,
  pinchScale,
  renderRatio,
  resolveScale,
  rotateBy,
  stepScale,
  turnedSize,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomText,
} from './pdfLayout'

const PAGE = { width: 612, height: 792 }

describe('zoom', () => {
  it('fits the width and the whole page inside the padded stage', () => {
    expect(fitWidthScale(PAGE, { width: 644, height: 500 })).toBeCloseTo(1)
    expect(fitPageScale(PAGE, { width: 1244, height: 824 })).toBeCloseTo(1)
    expect(fitPageScale(PAGE, { width: 644, height: 2000 })).toBeCloseTo(1)
    expect(fitWidthScale(PAGE, { width: 10, height: 10 })).toBe(1)
  })

  it('resolves a mode to a scale and clamps typed ones', () => {
    const stage = { width: 1244, height: 400 }
    expect(resolveScale('fit-width', PAGE, stage)).toBeCloseTo(1212 / 612)
    expect(resolveScale('fit-page', PAGE, stage)).toBeCloseTo(368 / 792)
    expect(resolveScale(1.5, PAGE, stage)).toBe(1.5)
    expect(resolveScale(99, PAGE, stage)).toBe(ZOOM_MAX)
    expect(clampScale(0.001)).toBe(ZOOM_MIN)
  })

  it('steps through the presets from any scale', () => {
    expect(stepScale(1, 1)).toBe(1.25)
    expect(stepScale(1, -1)).toBe(0.75)
    expect(stepScale(1.1, 1)).toBe(1.25)
    expect(stepScale(1.1, -1)).toBe(1)
    expect(stepScale(4, 1)).toBe(ZOOM_MAX)
    expect(stepScale(0.5, -1)).toBe(ZOOM_MIN)
  })

  it('follows a pinch gesture, bounded per event and overall', () => {
    expect(pinchScale(1, -10)).toBeGreaterThan(1)
    expect(pinchScale(1, 10)).toBeLessThan(1)
    expect(pinchScale(1, -1000)).toBeCloseTo(Math.exp(0.5))
    expect(pinchScale(ZOOM_MAX, -50)).toBe(ZOOM_MAX)
  })

  it('names the choice a mode stands for and reads it back', () => {
    expect(modeChoice('fit-width')).toBe('fit-width')
    expect(modeChoice(1.25)).toBe('zoom-125')
    expect(modeChoice(1.1)).toBeNull()
    expect(modeOfChoice('zoom-300')).toBe(3)
    expect(modeOfChoice('actual-size')).toBe(1)
    expect(modeOfChoice('fit-page')).toBe('fit-page')
    expect(modeOfChoice('zoom-7')).toBeNull()
    expect(zoomText(1.204)).toBe('120%')
  })
})

describe('rotation', () => {
  it('turns in quarter steps and swaps the size on an odd turn', () => {
    expect(rotateBy(270, 90)).toBe(0)
    expect(rotateBy(0, -90)).toBe(270)
    expect(turnedSize(PAGE, 90)).toEqual({ width: 792, height: 612 })
    expect(turnedSize(PAGE, 180)).toEqual(PAGE)
  })
})

describe('renderRatio', () => {
  it('uses the device ratio until the canvas would be too big', () => {
    expect(renderRatio({ width: 600, height: 800 }, 2, MAX_CANVAS_PIXELS)).toBe(2)
    expect(renderRatio({ width: 600, height: 800 }, 0.5, MAX_CANVAS_PIXELS)).toBe(1)
    const ratio = renderRatio({ width: 2400, height: 3200 }, 2, MAX_CANVAS_PIXELS)
    expect(ratio).toBeLessThan(2)
    expect(2400 * ratio * 3200 * ratio).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 1)
  })
})

describe('currentPage', () => {
  const rows = (count: number, height: number, gap: number) => ({
    count,
    top: (index: number) => gap + index * (height + gap),
    height: () => height,
  })

  it('names the page with the most of the window in it', () => {
    const pages = rows(10, 800, 12)
    const view = (scrollTop: number) => ({ scrollTop, height: 600, scrollHeight: 8120 })
    expect(currentPage(pages, view(0))).toBe(1)
    expect(currentPage(pages, view(812))).toBe(2)
    expect(currentPage(pages, view(1512))).toBe(3)
  })

  it('names the last page at the end and 0 with no pages', () => {
    const pages = rows(3, 800, 12)
    expect(currentPage(pages, { scrollTop: 1700, height: 900, scrollHeight: 2600 })).toBe(3)
    expect(currentPage(rows(0, 800, 12), { scrollTop: 0, height: 600, scrollHeight: 600 })).toBe(0)
  })
})

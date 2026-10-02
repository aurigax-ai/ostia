import { describe, expect, it } from 'vitest'
import {
  REGION_MIN,
  REGION_VIEW_MAX,
  normalizeRegionRequest,
  regionBusMessage,
  regionCapture,
  regionCaptureRect,
  regionPageRect,
  renderRegionReport,
} from './regionCapture'

const view = { width: 800, height: 600 }

describe('normalizeRegionRequest', () => {
  it('keeps a rectangle inside the page area, snapped outward to whole pixels', () => {
    expect(
      normalizeRegionRequest({ rect: { x: 10.4, y: 20.6, width: 99.2, height: 50 }, view }),
    ).toEqual({ rect: { x: 10, y: 20, width: 100, height: 51 }, view })
  })

  it('clamps sub-pixel overshoot at the edges', () => {
    expect(
      normalizeRegionRequest({ rect: { x: -0.5, y: 0, width: 800.6, height: 600 }, view }),
    ).toEqual({ rect: { x: 0, y: 0, width: 800, height: 600 }, view })
  })

  it('refuses a rectangle outside the page area', () => {
    expect(normalizeRegionRequest({ rect: { x: -20, y: 0, width: 50, height: 50 }, view })).toBe(
      null,
    )
    expect(normalizeRegionRequest({ rect: { x: 700, y: 0, width: 200, height: 50 }, view })).toBe(
      null,
    )
    expect(normalizeRegionRequest({ rect: { x: 0, y: 590, width: 50, height: 50 }, view })).toBe(
      null,
    )
  })

  it('refuses non-finite, missing or tiny values', () => {
    const rect = { x: 0, y: 0, width: 50, height: 50 }
    expect(normalizeRegionRequest(null)).toBe(null)
    expect(normalizeRegionRequest({ rect })).toBe(null)
    expect(normalizeRegionRequest({ rect: { ...rect, x: Number.NaN }, view })).toBe(null)
    expect(
      normalizeRegionRequest({ rect: { ...rect, width: Number.POSITIVE_INFINITY }, view }),
    ).toBe(null)
    expect(normalizeRegionRequest({ rect: { ...rect, height: '50' }, view })).toBe(null)
    expect(normalizeRegionRequest({ rect: { ...rect, width: REGION_MIN - 1 }, view })).toBe(null)
  })

  it('refuses a page area beyond the size cap', () => {
    const rect = { x: 0, y: 0, width: 50, height: 50 }
    expect(
      normalizeRegionRequest({ rect, view: { width: REGION_VIEW_MAX + 1, height: 600 } }),
    ).toBe(null)
    expect(normalizeRegionRequest({ rect, view: { width: 800, height: -1 } })).toBe(null)
  })
})

describe('region scaling', () => {
  it('scales the pane rectangle by the window zoom for capturePage', () => {
    const rect = { x: 10, y: 20, width: 100, height: 50 }
    expect(regionCaptureRect(rect, 1)).toEqual(rect)
    expect(regionCaptureRect(rect, 1.25)).toEqual({ x: 12, y: 25, width: 126, height: 63 })
    expect(regionCaptureRect(rect, Number.NaN)).toEqual(rect)
  })

  it('reports the rectangle in the page’s CSS px under page zoom', () => {
    const rect = { x: 10, y: 20, width: 100, height: 50 }
    expect(regionPageRect(rect, 1, 2)).toEqual({ x: 5, y: 10, width: 50, height: 25 })
    expect(regionPageRect(rect, 1.5, 1)).toEqual({ x: 15, y: 30, width: 150, height: 75 })
  })
})

describe('renderRegionReport', () => {
  const capture = regionCapture({
    id: 'region-1',
    url: 'http://localhost:5173/cart',
    title: 'Cart',
    rect: { x: 10, y: 20, width: 120, height: 80 },
    imageWidth: 240,
    imageHeight: 160,
    capturedAt: new Date('2026-10-01T10:00:00Z'),
  })
  const shot = '/tmp/pine-reports-1000/capture-2-localhost-5173-cart.png'

  it('names the page, region, image and note, and embeds the image', () => {
    const md = renderRegionReport(capture, '  header overlaps  ', shot)
    expect(md).toContain('# Captured region: Cart (120 × 80 CSS px)')
    expect(md).toContain('## Note\n\nheader overlaps\n')
    expect(md).toContain('- Page: Cart — http://localhost:5173/cart')
    expect(md).toContain('- Region: x 10, y 20, 120 × 80 (CSS px, viewport)')
    expect(md).toContain(`- Screenshot: ${shot} (240 × 160 px)`)
    expect(md).toContain('- Captured: 2026-10-01T10:00:00.000Z')
    expect(md).toContain(`## Screenshot\n\n![Captured region](${shot})`)
  })

  it('says there is no note', () => {
    expect(renderRegionReport(capture, ' ', shot)).toContain('(no note)')
  })

  it('has a bus message an agent can parse', () => {
    expect(JSON.parse(regionBusMessage(capture, ' fix ', '/r.md', shot))).toEqual({
      kind: 'capture',
      report: '/r.md',
      image: shot,
      url: 'http://localhost:5173/cart',
      region: { x: 10, y: 20, width: 120, height: 80 },
      note: 'fix',
    })
  })
})

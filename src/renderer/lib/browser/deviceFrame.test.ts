import { DEFAULT_DEVICE, withPreset } from '@shared/browser/browserDevice'
import { describe, expect, it } from 'vitest'
import { DEVICE_STAGE_GAP, deviceFrame, draggedDevice, unscaledRegion } from './deviceFrame'

const SAME_ZOOM = { app: 1, page: 1 }
const phone = withPreset(DEFAULT_DEVICE, 'iphone-16')
const roomy = { width: 2000, height: 2000 }

describe('deviceFrame', () => {
  it('shows a device that fits at its own size', () => {
    expect(deviceFrame(phone, roomy, SAME_ZOOM)).toEqual({ width: 393, height: 852, scale: 1 })
  })

  it('scales a device down to the room the stage leaves around it, never up', () => {
    const stage = { width: 800, height: 852 / 2 + 2 * DEVICE_STAGE_GAP }
    expect(deviceFrame(phone, stage, SAME_ZOOM).scale).toBeCloseTo(0.5)
    const narrow = { width: 393 / 4 + 2 * DEVICE_STAGE_GAP, height: 2000 }
    expect(deviceFrame(phone, narrow, SAME_ZOOM).scale).toBeCloseTo(0.25)
  })

  it('keeps 100% zoom at scale 1 however small the stage, and before it is measured', () => {
    const actual = { ...phone, zoom: 'actual' as const }
    expect(deviceFrame(actual, { width: 100, height: 100 }, SAME_ZOOM).scale).toBe(1)
    expect(deviceFrame(phone, { width: 0, height: 0 }, SAME_ZOOM).scale).toBe(1)
  })

  it('sizes the element so the page sees the device size at any app and page zoom', () => {
    const frame = deviceFrame(phone, roomy, { app: 1.25, page: 1 })
    expect(frame.width).toBeCloseTo(393 / 1.25)
    expect(deviceFrame(phone, roomy, { app: 1, page: 1.5 }).height).toBeCloseTo(852 * 1.5)
  })
})

describe('draggedDevice', () => {
  const drag = { device: DEFAULT_DEVICE, scale: 0.5, ratio: 1, right: true, bottom: false }

  it('grows the centred width by twice the pointer move at the shown scale', () => {
    expect(draggedDevice(drag, 10, 50)).toMatchObject({ width: 440, height: 800 })
  })

  it('grows the height from the bottom edge and both from the corner', () => {
    expect(draggedDevice({ ...drag, right: false, bottom: true }, 10, 50)).toMatchObject({
      width: 400,
      height: 900,
    })
    expect(draggedDevice({ ...drag, bottom: true }, -10, -50)).toMatchObject({
      width: 360,
      height: 700,
    })
  })

  it('never resizes a preset', () => {
    const preset = withPreset(DEFAULT_DEVICE, 'iphone-se')
    expect(draggedDevice({ ...drag, device: preset, bottom: true }, 100, 100)).toBe(preset)
  })
})

describe('unscaledRegion', () => {
  it('turns a crop on the scaled frame into the page’s own pixels', () => {
    expect(
      unscaledRegion({ x: 10, y: 20, width: 30, height: 40 }, { width: 200, height: 400 }, 0.5),
    ).toEqual({
      rect: { x: 20, y: 40, width: 60, height: 80 },
      view: { width: 400, height: 800 },
    })
  })
})

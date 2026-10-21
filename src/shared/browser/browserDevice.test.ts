import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEVICE,
  DEVICE_SIZE_MAX,
  DEVICE_SIZE_MIN,
  parseBrowserDevice,
  RESPONSIVE,
  resized,
  rotated,
  withPreset,
} from './browserDevice'

const responsive = { preset: RESPONSIVE, width: 600, height: 900, dpr: 2, zoom: 'actual' }

describe('parseBrowserDevice', () => {
  it('keeps a responsive device as saved', () => {
    expect(parseBrowserDevice(responsive)).toEqual(responsive)
  })

  it('clamps the size, falls back to fit and a ratio of 1 for unknown values', () => {
    expect(
      parseBrowserDevice({ preset: RESPONSIVE, width: 1, height: 1e9, dpr: 1.7, zoom: 'x' }),
    ).toEqual({
      preset: RESPONSIVE,
      width: DEVICE_SIZE_MIN,
      height: DEVICE_SIZE_MAX,
      dpr: 1,
      zoom: 'fit',
    })
  })

  it('takes a preset size and ratio from the data, keeping only its orientation and zoom', () => {
    expect(parseBrowserDevice({ preset: 'iphone-se', width: 1, height: 2, dpr: 9 })).toEqual({
      preset: 'iphone-se',
      width: 375,
      height: 667,
      dpr: 2,
      zoom: 'fit',
    })
    expect(
      parseBrowserDevice({ preset: 'iphone-se', width: 800, height: 300, zoom: 'actual' }),
    ).toEqual({ preset: 'iphone-se', width: 667, height: 375, dpr: 2, zoom: 'actual' })
  })

  it('reads a preset the data no longer has as responsive at its saved size', () => {
    expect(
      parseBrowserDevice({ preset: 'nokia-3310', width: 84, height: 48, dpr: 3, zoom: 'fit' }),
    ).toEqual({ preset: RESPONSIVE, width: 84, height: 50, dpr: 3, zoom: 'fit' })
  })

  it('refuses anything without a numeric size', () => {
    for (const raw of [undefined, null, 'iphone-se', [], { preset: RESPONSIVE }, { width: 1 }]) {
      expect(parseBrowserDevice(raw)).toBeUndefined()
    }
  })
})

describe('device changes', () => {
  it('picks a preset upright with its ratio, and responsive keeps the size it had', () => {
    const phone = withPreset({ ...DEFAULT_DEVICE, zoom: 'actual' }, 'pixel-9')
    expect(phone).toEqual({
      preset: 'pixel-9',
      width: 412,
      height: 924,
      dpr: 2.625,
      zoom: 'actual',
    })
    expect(withPreset(phone, RESPONSIVE)).toEqual({ ...phone, preset: RESPONSIVE })
  })

  it('rotates by swapping width and height', () => {
    expect(rotated(withPreset(DEFAULT_DEVICE, 'iphone-se'))).toMatchObject({
      width: 667,
      height: 375,
    })
  })

  it('resizes only a responsive device, clamped, and returns it unchanged when nothing moved', () => {
    expect(resized(DEFAULT_DEVICE, 320.4, 20)).toMatchObject({
      width: 320,
      height: DEVICE_SIZE_MIN,
    })
    expect(resized(DEFAULT_DEVICE, DEFAULT_DEVICE.width, DEFAULT_DEVICE.height)).toBe(
      DEFAULT_DEVICE,
    )
    const phone = withPreset(DEFAULT_DEVICE, 'iphone-se')
    expect(resized(phone, 500, 500)).toBe(phone)
  })
})

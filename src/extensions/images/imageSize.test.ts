import { describe, expect, it } from 'vitest'
import { DEFAULT_IMAGE_SIZE, resolveImageSize, svgViewBoxSize } from './imageSize'

const ZERO = { naturalWidth: 0, naturalHeight: 0, width: 0, height: 0 }

describe('svgViewBoxSize', () => {
  it('reads the size of a viewBox-only SVG', () => {
    expect(svgViewBoxSize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>')).toEqual(
      {
        width: 24,
        height: 24,
      },
    )
    expect(svgViewBoxSize("<svg viewBox='-2, -2, 48.5 32'></svg>")).toEqual({
      width: 48.5,
      height: 32,
    })
  })

  it('is null without a usable viewBox', () => {
    expect(svgViewBoxSize('<svg width="10" height="10"/>')).toBeNull()
    expect(svgViewBoxSize('<svg viewBox="0 0 0 24"/>')).toBeNull()
    expect(svgViewBoxSize('<svg viewBox="0 0 24"/>')).toBeNull()
    expect(svgViewBoxSize('<svg viewBox="a b c d"/>')).toBeNull()
  })
})

describe('resolveImageSize', () => {
  it('prefers the natural size', () => {
    expect(
      resolveImageSize({ naturalWidth: 640, naturalHeight: 360, width: 10, height: 10 }, null),
    ).toEqual({ width: 640, height: 360 })
  })

  it('falls back to the element size, then the viewBox, then 300 by 150', () => {
    expect(resolveImageSize({ ...ZERO, width: 48, height: 24 }, { width: 5, height: 5 })).toEqual({
      width: 48,
      height: 24,
    })
    expect(resolveImageSize(ZERO, { width: 24, height: 24 })).toEqual({ width: 24, height: 24 })
    expect(resolveImageSize(ZERO, null)).toEqual(DEFAULT_IMAGE_SIZE)
    expect(resolveImageSize({ ...ZERO, naturalWidth: 10 }, null)).toEqual(DEFAULT_IMAGE_SIZE)
  })
})

import { describe, expect, it } from 'vitest'
import { imageBlobType } from './imageType'

describe('imageBlobType', () => {
  it('names SVG and leaves the rest to the browser', () => {
    expect(imageBlobType('logo.SVG')).toBe('image/svg+xml')
    expect(imageBlobType('photo.png')).toBe('')
    expect(imageBlobType('svg')).toBe('')
  })
})

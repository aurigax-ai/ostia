import { describe, expect, it } from 'vitest'
import { mediaKind } from './mediaKind'

describe('mediaKind', () => {
  it('is video when the media has a picture', () => {
    expect(mediaKind(640)).toBe('video')
  })

  it('is audio when it has no picture', () => {
    expect(mediaKind(0)).toBe('audio')
  })
})

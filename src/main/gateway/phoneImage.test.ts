import { describe, expect, it } from 'vitest'
import { PHONE_IMAGE_MAX_BYTES, phoneImageOf } from './phoneImage'

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const encode = (head: number[], extra = 16) =>
  Buffer.concat([Buffer.from(head), Buffer.alloc(extra)]).toString('base64')

describe('phoneImageOf', () => {
  it('accepts PNG, JPEG and WebP whose bytes match the mime', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WEBPVP8 '),
      Buffer.alloc(8),
    ]).toString('base64')
    for (const image of [
      { mime: 'image/png', data: encode(PNG) },
      { mime: 'image/jpeg', data: encode([0xff, 0xd8, 0xff, 0xe0]) },
      { mime: 'image/webp', data: webp },
    ]) {
      expect(Buffer.isBuffer(phoneImageOf(image))).toBe(true)
    }
  })

  it('refuses a mime mismatch, an unknown mime and a non-object as image-type', () => {
    for (const image of [
      { mime: 'image/jpeg', data: encode(PNG) },
      { mime: 'image/gif', data: encode([0x47, 0x49, 0x46, 0x38]) },
      { mime: 'image/png', data: 5 },
      'png',
      null,
    ]) {
      expect(phoneImageOf(image)).toEqual({ ok: false, code: -32602, message: 'image-type' })
    }
  })

  it('refuses more than 10 MiB decoded as image-too-large before decoding it', () => {
    const big = { mime: 'image/png', data: encode(PNG, PHONE_IMAGE_MAX_BYTES) }
    expect(phoneImageOf(big)).toEqual({ ok: false, code: -32602, message: 'image-too-large' })
    const huge = { mime: 'image/png', data: 'A'.repeat(PHONE_IMAGE_MAX_BYTES * 2) }
    expect(phoneImageOf(huge)).toEqual({ ok: false, code: -32602, message: 'image-too-large' })
  })
})

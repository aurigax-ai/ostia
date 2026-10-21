import { describe, expect, it } from 'vitest'
import { CLIPBOARD_TEXT_MAX, normalizeClipboardCapture } from './clipboardCapture'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])

describe('normalizeClipboardCapture', () => {
  it('keeps text, html and a real png', () => {
    expect(normalizeClipboardCapture({ text: 'a', html: '<b>a</b>', png: PNG })).toEqual({
      text: 'a',
      html: '<b>a</b>',
      png: PNG,
    })
  })

  it('accepts an ArrayBuffer png', () => {
    const buffer = PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength)
    expect(normalizeClipboardCapture({ png: buffer })?.png).toEqual(PNG)
  })

  it('refuses nothing, non-objects, empty strings and non-png bytes', () => {
    expect(normalizeClipboardCapture(null)).toBeNull()
    expect(normalizeClipboardCapture('x')).toBeNull()
    expect(normalizeClipboardCapture({})).toBeNull()
    expect(normalizeClipboardCapture({ text: '' })).toBeNull()
    expect(normalizeClipboardCapture({ text: 5 })).toBeNull()
    expect(
      normalizeClipboardCapture({ png: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) }),
    ).toBeNull()
    expect(normalizeClipboardCapture({ text: 'a', png: 'png' })).toBeNull()
  })

  it('caps text and html', () => {
    const long = 'x'.repeat(CLIPBOARD_TEXT_MAX + 10)
    const capture = normalizeClipboardCapture({ text: long, html: long })
    expect(capture?.text?.length).toBe(CLIPBOARD_TEXT_MAX)
    expect(capture?.html?.length).toBe(CLIPBOARD_TEXT_MAX)
  })
})

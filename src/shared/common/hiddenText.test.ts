import { describe, expect, it } from 'vitest'
import { codeEscape, isControl, isHiddenFormat } from './hiddenText'

describe('hiddenText', () => {
  it('names C0, DEL and C1 as controls and leaves printable text alone', () => {
    expect([0x00, 0x1b, 0x7f, 0x85, 0x9b].every(isControl)).toBe(true)
    expect([0x20, 0x41, 0xa0, 0x4e2d].some(isControl)).toBe(false)
  })

  it('names the reordering controls and line separators as hidden', () => {
    const hidden = [0x061c, 0x202a, 0x202e, 0x2066, 0x2069, 0x2028, 0x2029]
    expect(hidden.every(isHiddenFormat)).toBe(true)
  })

  it('leaves joiners and direction marks that real text needs', () => {
    const kept = [0x200c, 0x200d, 0x200e, 0x200f, 0x2027, 0x2030, 0x41, 0x4e2d]
    expect(kept.some(isHiddenFormat)).toBe(false)
  })

  it('escapes as \\x for one byte and \\u above', () => {
    expect(codeEscape(0x1b)).toBe('\\x1b')
    expect(codeEscape(0x202e)).toBe('\\u202e')
  })
})

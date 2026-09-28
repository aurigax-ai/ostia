import { describe, expect, it } from 'vitest'
import { isDangerousSegment } from './protoGuard'

describe('protoGuard', () => {
  describe('isDangerousSegment', () => {
    it.each(['__proto__', 'prototype', 'constructor'])('flags %s', (segment) => {
      expect(isDangerousSegment(segment)).toBe(true)
    })

    it('is case-sensitive (does not flag a differently-cased lookalike)', () => {
      expect(isDangerousSegment('__PROTO__')).toBe(false)
      expect(isDangerousSegment('Constructor')).toBe(false)
    })

    it('does not flag an ordinary key', () => {
      expect(isDangerousSegment('theme')).toBe(false)
      expect(isDangerousSegment('')).toBe(false)
    })
  })
})

import { describe, expect, it } from 'vitest'
import { hasDangerousSegment, isDangerousSegment } from './protoGuard'

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

  describe('hasDangerousSegment', () => {
    it('flags a bare dangerous slug/key with no dots', () => {
      expect(hasDangerousSegment('__proto__')).toBe(true)
    })

    it('flags a dangerous segment anywhere in a dot-path, not just the leaf', () => {
      expect(hasDangerousSegment('__proto__.polluted')).toBe(true)
      expect(hasDangerousSegment('a.constructor.prototype.polluted')).toBe(true)
      expect(hasDangerousSegment('appearance.terminal.constructor')).toBe(true)
    })

    it('passes an ordinary settings dot-path', () => {
      expect(hasDangerousSegment('appearance.terminal.size')).toBe(false)
    })
  })
})

import { describe, expect, it } from 'vitest'
import { normalizeOrigin } from './credentials'

describe('normalizeOrigin', () => {
  it('keeps only the scheme, host and port of an http(s) URL', () => {
    expect(normalizeOrigin('https://github.com/login?x=1')).toBe('https://github.com')
    expect(normalizeOrigin('http://localhost:3000/a')).toBe('http://localhost:3000')
  })

  it('refuses other schemes and junk', () => {
    expect(normalizeOrigin('file:///etc/passwd')).toBeNull()
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull()
    expect(normalizeOrigin('github.com')).toBeNull()
  })
})

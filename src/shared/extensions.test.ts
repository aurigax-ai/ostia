import { describe, expect, it } from 'vitest'
import { SIDEBAR_URL_MAX, sidebarItemUrl } from './extensions'

describe('sidebarItemUrl', () => {
  it('accepts http and https URLs, normalized', () => {
    expect(sidebarItemUrl('http://localhost:3000')).toBe('http://localhost:3000/')
    expect(sidebarItemUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
  })

  it('refuses other schemes, junk and oversized values', () => {
    expect(sidebarItemUrl('file:///etc/passwd')).toBeNull()
    expect(sidebarItemUrl('javascript:alert(1)')).toBeNull()
    expect(sidebarItemUrl('not a url')).toBeNull()
    expect(sidebarItemUrl(42)).toBeNull()
    expect(sidebarItemUrl(`http://x/${'a'.repeat(SIDEBAR_URL_MAX)}`)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { loopbackOrigin } from './extensionPanels'

describe('loopbackOrigin', () => {
  it('accepts only plain-http loopback URLs', () => {
    expect(loopbackOrigin('http://127.0.0.1:4000/x?t=1')).toBe('http://127.0.0.1:4000')
    expect(loopbackOrigin('http://localhost:4000/')).toBe('http://localhost:4000')
    expect(loopbackOrigin('https://127.0.0.1:4000/')).toBeNull()
    expect(loopbackOrigin('http://192.168.1.2:4000/')).toBeNull()
    expect(loopbackOrigin('http://127.0.0.1.evil.com/')).toBeNull()
    expect(loopbackOrigin('file:///etc/passwd')).toBeNull()
    expect(loopbackOrigin('garbage')).toBeNull()
  })
})

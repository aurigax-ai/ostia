import { describe, expect, it } from 'vitest'
import { hostOf, parseServerUrl, socketOrigin } from './serverUrl'

describe('the server address', () => {
  it('SVA-C8 takes a bare host as https and keeps only the origin', () => {
    expect(parseServerUrl('ostia.example.com', false)).toBe('https://ostia.example.com')
    expect(parseServerUrl('  https://ostia.example.com:8443/ ', false)).toBe(
      'https://ostia.example.com:8443',
    )
  })

  it('SVA-C9 allows http only for this computer, or when unpackaged', () => {
    expect(parseServerUrl('http://example.com', false)).toBeNull()
    expect(parseServerUrl('http://localhost:8080', false)).toBe('http://localhost:8080')
    expect(parseServerUrl('http://127.0.0.1:9', false)).toBe('http://127.0.0.1:9')
    expect(parseServerUrl('http://[::1]:9', false)).toBe('http://[::1]:9')
    expect(parseServerUrl('http://example.com', true)).toBe('http://example.com')
  })

  it('SVA-C10 refuses paths, credentials, queries, other schemes and nonsense', () => {
    for (const text of [
      '',
      '   ',
      'https://example.com/v1',
      'https://user:pw@example.com',
      'https://example.com/?a=1',
      'https://example.com/#x',
      'ftp://example.com',
      'ws://example.com',
      'https://',
    ]) {
      expect(parseServerUrl(text, true)).toBeNull()
    }
  })

  it('SVA-C11 maps the origin to its socket scheme and host', () => {
    expect(socketOrigin('https://a.example')).toBe('wss://a.example')
    expect(socketOrigin('http://127.0.0.1:5')).toBe('ws://127.0.0.1:5')
    expect(hostOf('https://a.example:8443')).toBe('a.example:8443')
  })
})

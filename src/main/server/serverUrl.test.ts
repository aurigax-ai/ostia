import { describe, expect, it } from 'vitest'
import { defaultServerUrl, hostOf, parseServerUrl, socketOrigin } from './serverUrl'

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

describe('the default server', () => {
  it('SVA-C56 is nothing unless the build stamp or, unpackaged, the environment names one', () => {
    expect(defaultServerUrl(true, {}, undefined)).toBeNull()
    expect(defaultServerUrl(false, {}, undefined)).toBeNull()
    expect(defaultServerUrl(true, {}, 'ostia.example.com')).toBe('https://ostia.example.com')
  })

  it('SVA-C57 takes OSTIA_SERVER_URL only when unpackaged, and over the stamp', () => {
    const env = { OSTIA_SERVER_URL: 'http://example.test:8080' }
    expect(defaultServerUrl(false, env, 'ostia.example.com')).toBe('http://example.test:8080')
    expect(defaultServerUrl(true, env, undefined)).toBeNull()
    expect(defaultServerUrl(true, env, 'ostia.example.com')).toBe('https://ostia.example.com')
  })

  it('SVA-C58 refuses a stamp that is not a valid address', () => {
    expect(defaultServerUrl(true, {}, 'http://example.com')).toBeNull()
    expect(defaultServerUrl(true, {}, 'https://example.com/path')).toBeNull()
  })
})

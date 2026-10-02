import { describe, expect, it } from 'vitest'
import { isLocalHost, loadLocalHostName, parseOsc7 } from './osc7'

describe('parseOsc7', () => {
  it('splits the host from the path and keeps percent signs as written', () => {
    expect(parseOsc7('file://devbox/home/u/100%20off')).toEqual({
      host: 'devbox',
      path: '/home/u/100%20off',
    })
    expect(parseOsc7('file:///tmp')).toEqual({ host: '', path: '/tmp' })
  })

  it('ignores reports that are not file URLs with an absolute path', () => {
    expect(parseOsc7('kitty-shell-cwd://devbox/tmp')).toBeNull()
    expect(parseOsc7('file://devbox')).toBeNull()
  })
})

describe('isLocalHost', () => {
  it('SSH-C37 treats this machine’s full or short name, localhost and no host as local', () => {
    for (const host of ['devbox.lan', 'DEVBOX', 'devbox', 'localhost', '']) {
      expect(isLocalHost(host, 'devbox.lan'), host).toBe(true)
    }
  })

  it('SSH-C37 treats any other host as remote', () => {
    expect(isLocalHost('db', 'devbox.lan')).toBe(false)
    expect(isLocalHost('devbox.corp', 'devbox.lan')).toBe(false)
  })

  it('treats every host as local while this machine’s name is unknown', () => {
    expect(isLocalHost('db', null)).toBe(true)
  })

  it('learns this machine’s name from main', async () => {
    await loadLocalHostName()
    expect(isLocalHost('devbox')).toBe(true)
    expect(isLocalHost('db')).toBe(false)
  })
})

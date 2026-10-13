import { describe, expect, it } from 'vitest'
import { browserUserAgent } from './browserUserAgent'

const ELECTRON =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ostia/0.4.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36'

describe('browserUserAgent', () => {
  it('reads as the Chrome it is built on, without the Electron and app tokens sites treat as a bot', () => {
    expect(browserUserAgent(ELECTRON, 'ostia')).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36',
    )
  })

  it('removes the app token whatever the product is called, and leaves other agents alone', () => {
    expect(browserUserAgent(ELECTRON.replace('ostia/', 'My.App/'), 'my.app')).not.toContain('App/')
    const chrome = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0 Safari/537.36'
    expect(browserUserAgent(chrome, 'ostia')).toBe(chrome)
  })
})

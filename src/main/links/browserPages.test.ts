import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

const { browserLaunch } = await import('./browserPages')

const url = 'chrome://inspect/#remote-debugging'
const host = (over: object) => ({
  platform: 'linux' as const,
  env: { PATH: '/opt/bin:/usr/bin' },
  home: '/home/u',
  exists: () => false,
  ...over,
})

describe('browserLaunch', () => {
  it('uses the first installed Linux binary with the address as one argument', () => {
    const exists = (path: string) =>
      path === '/usr/bin/chromium' || path === '/usr/bin/google-chrome'
    expect(browserLaunch('chrome', url, host({ exists }))).toEqual({
      app: 'Google Chrome',
      command: '/usr/bin/google-chrome',
      args: [url],
    })
    expect(
      browserLaunch('chrome', url, host({ exists: (p: string) => p === '/usr/bin/chromium' })),
    ).toMatchObject({
      app: 'Chromium',
    })
  })

  it('answers null when the browser is not installed, and ignores relative PATH entries', () => {
    expect(browserLaunch('edge', 'edge://settings', host({}))).toBeNull()
    const relative = host({ env: { PATH: 'bin' }, exists: () => true })
    expect(browserLaunch('brave', 'brave://settings', relative)).toBeNull()
  })

  it('opens an installed macOS app bundle with open -a', () => {
    const exists = (path: string) => path === '/Applications/Brave Browser.app'
    expect(
      browserLaunch('brave', 'brave://settings', host({ platform: 'darwin', exists })),
    ).toEqual({
      app: 'Brave Browser',
      command: 'open',
      args: ['-a', 'Brave Browser', 'brave://settings'],
    })
  })

  it('finds the Windows executable under a program folder', () => {
    const env = { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
    const exists = (path: string) =>
      path === 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    expect(
      browserLaunch('edge', 'edge://settings', host({ platform: 'win32', env, exists })),
    ).toEqual({
      app: 'Microsoft Edge',
      command: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      args: ['edge://settings'],
    })
  })
})

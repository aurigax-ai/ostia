import { afterEach, describe, expect, it, vi } from 'vitest'

async function defaultsOn(mac: boolean): Promise<boolean> {
  vi.resetModules()
  vi.doMock('../platform', () => ({
    platform: mac ? 'darwin' : 'linux',
    isMac: mac,
    isLinux: !mac,
  }))
  const { useSettingsStore } = await import('./settingsStore')
  return useSettingsStore.getState().behavior.wheelZoom
}

describe('behavior.wheelZoom default', () => {
  afterEach(() => {
    vi.doUnmock('../platform')
    vi.resetModules()
  })

  it('is off on macOS, where Cmd+scroll is easy to hit by accident', async () => {
    expect(await defaultsOn(true)).toBe(false)
  })

  it('is on elsewhere, where Ctrl+scroll zoom is the usual habit', async () => {
    expect(await defaultsOn(false)).toBe(true)
  })
})

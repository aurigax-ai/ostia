import { describe, expect, it, vi } from 'vitest'

async function defaultOn(mac: boolean): Promise<boolean> {
  vi.resetModules()
  vi.doMock('../platform', () => ({
    platform: mac ? 'darwin' : 'linux',
    isMac: mac,
    isLinux: !mac,
  }))
  const { useSettingsStore } = await import('./settingsStore')
  const value = useSettingsStore.getState().behavior.wheelZoom
  vi.doUnmock('../platform')
  vi.resetModules()
  return value
}

describe('behavior.wheelZoom default', () => {
  it('keeps modifier+scroll zoom on by default on every platform, so nothing changes until someone turns it off', async () => {
    expect(await defaultOn(true)).toBe(true)
    expect(await defaultOn(false)).toBe(true)
  })
})

import { describe, expect, it, vi } from 'vitest'

type Store = typeof import('./settingsStore')

async function storeOn(mac: boolean): Promise<Store> {
  vi.resetModules()
  vi.doMock('@/platform', () => ({
    platform: mac ? 'darwin' : 'linux',
    isMac: mac,
    isLinux: !mac,
  }))
  const store = await import('./settingsStore')
  vi.doUnmock('@/platform')
  return store
}

function loaded(store: Store, behavior?: object): boolean {
  const saved = behavior === undefined ? {} : { behavior }
  return store.parsePersisted(saved as never).behavior.wheelZoom
}

describe('behavior.wheelZoom default', () => {
  it('is off on macOS, where Cmd+scroll is easy to hit on a trackpad', async () => {
    const { useSettingsStore } = await storeOn(true)
    expect(useSettingsStore.getState().behavior.wheelZoom).toBe(false)
  })

  it('is on elsewhere, where Ctrl+scroll zoom is common', async () => {
    const { useSettingsStore } = await storeOn(false)
    expect(useSettingsStore.getState().behavior.wheelZoom).toBe(true)
  })

  it('fills the platform default when no value was saved', async () => {
    const mac = await storeOn(true)
    expect(loaded(mac)).toBe(false)
    expect(loaded(mac, { cursorBlink: false })).toBe(false)
    const linux = await storeOn(false)
    expect(loaded(linux)).toBe(true)
    expect(loaded(linux, { cursorBlink: false })).toBe(true)
  })

  it('keeps a value the person already saved, on either platform', async () => {
    const mac = await storeOn(true)
    expect(loaded(mac, { wheelZoom: true })).toBe(true)
    const linux = await storeOn(false)
    expect(loaded(linux, { wheelZoom: false })).toBe(false)
  })
})

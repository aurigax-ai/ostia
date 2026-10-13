import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSystemThemeStore } from './systemThemeStore'

describe('systemThemeStore', () => {
  afterEach(() => {
    useSystemThemeStore.setState({ dark: true })
    vi.restoreAllMocks()
  })

  it('reads the OS appearance at init and follows later changes pushed from main', async () => {
    vi.mocked(window.ostia.window.isSystemDark).mockResolvedValue(false)
    let push: (dark: boolean) => void = () => {}
    vi.mocked(window.ostia.window.onSystemDarkChange).mockImplementation((cb) => {
      push = cb
      return () => {}
    })

    await useSystemThemeStore.getState().init()
    expect(useSystemThemeStore.getState().dark).toBe(false)

    push(true)
    expect(useSystemThemeStore.getState().dark).toBe(true)
  })
})

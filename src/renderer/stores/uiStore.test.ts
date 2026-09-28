import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useUIStore } from './uiStore'

const state = () => useUIStore.getState()

describe('uiStore', () => {
  let init: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    init = useUIStore.getState()
  })

  afterEach(() => {
    useUIStore.setState(init, true)
  })

  it('starts with the documented initial state', () => {
    expect(state().paletteOpen).toBe(false)
    expect(state().railCollapsed).toBe(false)
    expect(state().settingsTabOpen).toBe(false)
    expect(state().settingsActive).toBe(false)
    expect(state().sidebarView).toBe('workspaces')
  })

  describe('palette', () => {
    it('openPalette sets paletteOpen true; closePalette sets it false', () => {
      state().openPalette()
      expect(state().paletteOpen).toBe(true)

      state().closePalette()
      expect(state().paletteOpen).toBe(false)
    })

    it('togglePalette flips paletteOpen, and back to the original on a second call', () => {
      state().togglePalette()
      expect(state().paletteOpen).toBe(true)

      state().togglePalette()
      expect(state().paletteOpen).toBe(false)
    })
  })

  describe('toggleRail', () => {
    it('flips railCollapsed, and back to the original on a second call', () => {
      state().toggleRail()
      expect(state().railCollapsed).toBe(true)

      state().toggleRail()
      expect(state().railCollapsed).toBe(false)
    })
  })

  describe('settings', () => {
    it('openSettings sets BOTH settingsTabOpen and settingsActive true', () => {
      state().openSettings()
      expect(state().settingsTabOpen).toBe(true)
      expect(state().settingsActive).toBe(true)
    })

    it('closeSettings clears BOTH settingsTabOpen and settingsActive', () => {
      state().openSettings()

      state().closeSettings()
      expect(state().settingsTabOpen).toBe(false)
      expect(state().settingsActive).toBe(false)
    })

    it('leaveSettings clears only settingsActive, keeping the tab open', () => {
      state().openSettings()

      state().leaveSettings()
      expect(state().settingsActive).toBe(false)
      expect(state().settingsTabOpen).toBe(true)
    })
  })

  describe('setSidebarView', () => {
    it("switches sidebarView to 'files' and back to 'workspaces'", () => {
      state().setSidebarView('files')
      expect(state().sidebarView).toBe('files')

      state().setSidebarView('workspaces')
      expect(state().sidebarView).toBe('workspaces')
    })
  })
})

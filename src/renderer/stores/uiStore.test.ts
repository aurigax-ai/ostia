import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useUIStore } from './uiStore'

/**
 * uiStore is a pure, dependency-free zustand store: booleans for chrome visibility
 * (palette / rail / inspector), a two-flag Settings model (settingsTabOpen + settingsActive),
 * and the sidebar view. These tests INVOKE each action via getState().<action>() and assert
 * the exact resulting state — the point is to actually exercise the action functions (which
 * elsewhere are only ever spied on), including openSettings/closeSettings touching BOTH
 * settings flags and leaveSettings clearing only settingsActive.
 */

const state = () => useUIStore.getState()

describe('uiStore', () => {
  let init: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    // Snapshot pristine state (data + stable action fns) before any test mutates.
    init = useUIStore.getState()
  })

  afterEach(() => {
    // Restore to pristine (replace, not merge) so flips don't bleed between tests.
    useUIStore.setState(init, true)
  })

  it('starts with the documented initial state', () => {
    expect(state().paletteOpen).toBe(false)
    expect(state().railCollapsed).toBe(false)
    expect(state().inspectorOpen).toBe(true)
    expect(state().settingsTabOpen).toBe(false)
    expect(state().settingsActive).toBe(false)
    expect(state().sidebarView).toBe('sessions')
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

  describe('toggleInspector', () => {
    it('flips inspectorOpen (initial true), and back to true on a second call', () => {
      state().toggleInspector()
      expect(state().inspectorOpen).toBe(false)

      state().toggleInspector()
      expect(state().inspectorOpen).toBe(true)
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
    it("switches sidebarView to 'files' and back to 'sessions'", () => {
      state().setSidebarView('files')
      expect(state().sidebarView).toBe('files')

      state().setSidebarView('sessions')
      expect(state().sidebarView).toBe('sessions')
    })
  })
})

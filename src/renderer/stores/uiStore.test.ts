import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { paletteReturnFocus } from '../lib/paletteFocus'
import { coversWorkspaces, useUIStore } from './uiStore'

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
    expect(state().filesOpen).toBe(false)
  })

  describe('palette', () => {
    it('openPalette sets paletteOpen true; closePalette sets it false', () => {
      state().openPalette()
      expect(state().paletteOpen).toBe(true)

      state().closePalette()
      expect(state().paletteOpen).toBe(false)
    })

    it('takes focus off the terminal the moment the palette opens and gives it back on close', () => {
      const terminal = document.createElement('textarea')
      document.body.append(terminal)
      terminal.focus()
      state().togglePalette()
      expect(document.activeElement).toBe(document.body)
      expect(paletteReturnFocus()).toBe(terminal)
      terminal.remove()
    })

    it('leaves focus where a command moved it while the palette was open', () => {
      const terminal = document.createElement('textarea')
      const other = document.createElement('input')
      document.body.append(terminal, other)
      terminal.focus()
      state().openPalette()
      other.focus()
      expect(paletteReturnFocus()).toBe(false)
      terminal.remove()
      other.remove()
    })

    it('togglePalette flips paletteOpen, and back to the original on a second call', () => {
      state().togglePalette()
      expect(state().paletteOpen).toBe(true)

      state().togglePalette()
      expect(state().paletteOpen).toBe(false)
    })

    it('togglePalette opens the palette on the commands prefix and clears it on close', () => {
      state().togglePalette()
      expect(state()).toMatchObject({ paletteOpen: true, paletteMode: 'search', paletteSeed: '>' })

      state().togglePalette()
      expect(state()).toMatchObject({ paletteOpen: false, paletteSeed: '' })
    })
  })

  describe('dashboard', () => {
    it('opens and toggles the dashboard', () => {
      state().openDashboard()
      expect(state().dashboardActive).toBe(true)
      state().toggleDashboard()
      expect(state().dashboardActive).toBe(false)
      state().toggleDashboard()
      expect(state().dashboardActive).toBe(true)
    })

    it('shows the dashboard or Settings, never both', () => {
      state().openSettings()
      state().openDashboard()
      expect(state().settingsActive).toBe(false)
      expect(state().settingsTabOpen).toBe(true)
      state().openSettings()
      expect(state().dashboardActive).toBe(false)
      state().openDashboard()
      state().openWorkspaceSettings('w1')
      expect(state().dashboardActive).toBe(false)
    })

    it('showWorkspaces leaves the dashboard, and either one covers the workspaces', () => {
      expect(coversWorkspaces(state())).toBe(false)
      state().openDashboard()
      expect(coversWorkspaces(state())).toBe(true)
      state().showWorkspaces()
      expect(state().dashboardActive).toBe(false)
      expect(coversWorkspaces(state())).toBe(false)
      state().openSettings()
      expect(coversWorkspaces(state())).toBe(true)
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

    it('showWorkspaces clears only settingsActive, keeping the tab open', () => {
      state().openSettings()

      state().showWorkspaces()
      expect(state().settingsActive).toBe(false)
      expect(state().settingsTabOpen).toBe(true)
    })
  })

  describe('toggleFiles', () => {
    it('opens and closes the files panel', () => {
      state().toggleFiles()
      expect(state().filesOpen).toBe(true)
      state().toggleFiles()
      expect(state().filesOpen).toBe(false)
    })
  })

  describe('searchFiles', () => {
    it('opens the files panel and asks its search box for the focus once', () => {
      state().searchFiles()
      expect(state()).toMatchObject({ filesOpen: true, filesSearchFocus: true })
      state().filesSearchFocused()
      expect(state().filesSearchFocus).toBe(false)
      state().searchFiles()
      state().toggleFiles()
      expect(state()).toMatchObject({ filesOpen: false, filesSearchFocus: false })
    })
  })
})

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { SettingsPanel } from './SettingsPanel'

/**
 * SettingsPanel is the full-window preferences surface, gated behind uiStore.settingsActive.
 * A left nav switches between panes (Appearance / Terminal / Files / Language / …); each pane
 * renders Base-UI Selects, Switches and number/text Inputs whose changes flow into the
 * settingsStore setters (setTheme / setLocale / setBehavior / setSurfaceFont). Theme + language
 * options come from pluginsStore's built-in contributions.
 *
 * These tests drive the REAL controls (open the Base-UI Select, click options, toggle the
 * Switch, change the Inputs) and assert the store setter is called with the right args, that
 * seeded values are reflected in the controls, and that controls expose accessible names.
 *
 * Mocking: none beyond the per-test window.pine fake from test/setup.ts — SettingsPanel pulls
 * in no Monaco/xterm (the raw settings.json lives in a real editor pane opened elsewhere, via
 * layoutStore.openFile, not embedded here). The setters are SPIED-and-stubbed before render so
 * the assertion sees the call without the store's debounced fs.write firing after the test.
 * jsdom lacks Element.getAnimations, which Base-UI's ScrollArea polls on a timer — shim it so
 * that timer doesn't surface as an unhandled rejection after the test completes.
 */

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

/** Mount the panel with Settings selected as the active center view. */
function renderSettings(): void {
  useUIStore.setState({ settingsActive: true, settingsTabOpen: true })
  render(<SettingsPanel />)
}

describe('SettingsPanel', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let pluginsInit: ReturnType<typeof usePluginsStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
    uiInit = useUIStore.getState()
    pluginsInit = usePluginsStore.getState()
  })

  afterEach(() => {
    // Unmount BEFORE resetting stores so a still-mounted tree can't re-render against
    // about-to-be-restored state, then restore spies last.
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    useUIStore.setState(uiInit, true)
    usePluginsStore.setState(pluginsInit, true)
    vi.restoreAllMocks()
  })

  it('renders the settings surface with its section nav and the Appearance pane by default', () => {
    renderSettings()

    // The whole surface is a labelled region (a11y anchor), not a bare div.
    expect(screen.getByRole('region', { name: 'Settings' })).toBeInTheDocument()

    // Left-nav sections are real buttons reachable by their labels.
    for (const name of ['Appearance', 'Terminal', 'Files', 'Language', 'About']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: 'Open settings file' })).toBeInTheDocument()

    // Appearance is the default pane: its heading + the theme/font control labels are shown.
    expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument()
    expect(screen.getByText('Theme')).toBeInTheDocument()
    expect(screen.getByText('UI font')).toBeInTheDocument()
    expect(screen.getByText('Terminal font')).toBeInTheDocument()
    expect(screen.getByText('Editor font')).toBeInTheDocument()
  })

  it('returns null while Settings is not the active view', () => {
    useUIStore.setState({ settingsActive: false })
    const { container } = render(<SettingsPanel />)

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('region', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('sources theme options from pluginsStore — a custom theme appears and selecting it calls setTheme', async () => {
    // Prove the options come from the store, not a hard-coded list: inject a theme the
    // component could not know about, then require it to show up as a selectable option.
    usePluginsStore.setState((s) => ({
      themes: [
        ...s.themes,
        { id: 'test-theme', name: 'Test Theme', appearance: 'dark', tokens: s.themes[0].tokens },
      ],
    }))
    const setTheme = vi.spyOn(useSettingsStore.getState(), 'setTheme').mockImplementation(() => {})
    renderSettings()
    const user = userEvent.setup()

    await user.click(screen.getByRole('combobox', { name: 'Theme' }))

    // The built-ins still render, and so does the injected custom theme.
    for (const name of ['One Dark Vivid', 'Dracula', 'Test Theme']) {
      expect(await screen.findByRole('option', { name })).toBeInTheDocument()
    }

    await user.click(screen.getByRole('option', { name: 'Test Theme' }))

    expect(setTheme).toHaveBeenCalledWith('test-theme')
  })

  it('reflects the current theme in the theme picker trigger', () => {
    useSettingsStore.setState((s) => ({ appearance: { ...s.appearance, theme: 'oxocarbon' } }))
    renderSettings()

    // The trigger label shows the human name of the seeded theme id, not the raw id.
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveTextContent('Oxocarbon')
  })

  it('changes the display language via the Language section, calling setLocale', async () => {
    const setLocale = vi
      .spyOn(useSettingsStore.getState(), 'setLocale')
      .mockImplementation(() => {})
    renderSettings()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Language' }))
    await user.click(screen.getByRole('combobox', { name: 'Language' }))

    // Both contributed language packs are listed.
    expect(await screen.findByRole('option', { name: 'English' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: '繁體中文' }))

    expect(setLocale).toHaveBeenCalledWith('zh-Hant')
  })

  it('toggles Show hidden files (Files section) via setBehavior with the right patch', async () => {
    // Seeded true (the default) so the first click requests false.
    useSettingsStore.setState((s) => ({ behavior: { ...s.behavior, showHiddenFiles: true } }))
    const setBehavior = vi
      .spyOn(useSettingsStore.getState(), 'setBehavior')
      .mockImplementation(() => {})
    renderSettings()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Files' }))
    const toggle = screen.getByRole('switch', { name: 'Show hidden files' })
    expect(toggle).toBeChecked()

    await user.click(toggle)

    expect(setBehavior).toHaveBeenCalledWith({ showHiddenFiles: false })
  })

  it('changes the cursor style (Terminal section) via setBehavior', async () => {
    const setBehavior = vi
      .spyOn(useSettingsStore.getState(), 'setBehavior')
      .mockImplementation(() => {})
    renderSettings()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Terminal' }))
    await user.click(screen.getByRole('combobox', { name: 'Cursor style' }))

    // The three cursor styles render as localized option labels.
    for (const name of ['Block', 'Underline', 'Bar']) {
      expect(await screen.findByRole('option', { name })).toBeInTheDocument()
    }
    await user.click(screen.getByRole('option', { name: 'Underline' }))

    expect(setBehavior).toHaveBeenCalledWith({ cursorStyle: 'underline' })
  })

  it('toggles Cursor blink (Terminal section) via setBehavior, reflecting the seeded value', async () => {
    useSettingsStore.setState((s) => ({ behavior: { ...s.behavior, cursorBlink: true } }))
    const setBehavior = vi
      .spyOn(useSettingsStore.getState(), 'setBehavior')
      .mockImplementation(() => {})
    renderSettings()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Terminal' }))
    const blink = screen.getByRole('switch', { name: 'Cursor blink' })
    expect(blink).toBeChecked()

    await user.click(blink)

    expect(setBehavior).toHaveBeenCalledWith({ cursorBlink: false })
  })

  it('changes a font family via setSurfaceFont with the surface + patch', () => {
    const setSurfaceFont = vi
      .spyOn(useSettingsStore.getState(), 'setSurfaceFont')
      .mockImplementation(() => {})
    renderSettings()

    // fireEvent.change gives one deterministic onChange for the controlled input.
    fireEvent.change(screen.getByRole('textbox', { name: 'UI font — Family' }), {
      target: { value: 'JetBrains Mono' },
    })

    expect(setSurfaceFont).toHaveBeenCalledWith('ui', { family: 'JetBrains Mono' })
  })

  it('changes a font size via setSurfaceFont, clamping to the 8–32 range', () => {
    const setSurfaceFont = vi
      .spyOn(useSettingsStore.getState(), 'setSurfaceFont')
      .mockImplementation(() => {})
    renderSettings()
    const sizeInput = screen.getByRole('spinbutton', { name: 'Terminal font — Size' })

    fireEvent.change(sizeInput, { target: { value: '18' } })
    expect(setSurfaceFont).toHaveBeenLastCalledWith('terminal', { size: 18 })

    // Above the range clamps to the max before it reaches the setter…
    fireEvent.change(sizeInput, { target: { value: '99' } })
    expect(setSurfaceFont).toHaveBeenLastCalledWith('terminal', { size: 32 })

    // …and below the range clamps up to the min.
    fireEvent.change(sizeInput, { target: { value: '1' } })
    expect(setSurfaceFont).toHaveBeenLastCalledWith('terminal', { size: 8 })
  })

  it('reflects the current appearance settings in the controls', () => {
    useSettingsStore.setState((s) => ({
      appearance: {
        ...s.appearance,
        theme: 'dracula',
        ui: { family: 'Comic Code', size: 20 },
      },
    }))
    renderSettings()

    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveTextContent('Dracula')
    expect(screen.getByRole('textbox', { name: 'UI font — Family' })).toHaveValue('Comic Code')
    expect(screen.getByRole('spinbutton', { name: 'UI font — Size' })).toHaveValue(20)
  })

  it('exposes accessible names on its controls (a11y)', async () => {
    renderSettings()
    const user = userEvent.setup()

    // Appearance pane controls are reachable by role + accessible name.
    expect(screen.getByRole('combobox', { name: 'Theme' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'UI font — Family' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'UI font — Size' })).toBeInTheDocument()

    // A switch control is likewise named (in the Files pane).
    await user.click(screen.getByRole('button', { name: 'Files' }))
    expect(screen.getByRole('switch', { name: 'Show hidden files' })).toBeInTheDocument()
  })
})

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { SettingsPanel } from './SettingsPanel'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

function renderSettings(): void {
  useUIStore.setState({ settingsActive: true, settingsTabOpen: true })
  render(<SettingsPanel />)
}

describe('SettingsPanel', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let pluginsInit: ReturnType<typeof usePluginsStore.getState>

  beforeAll(() => {
    Object.assign(window, {
      queryLocalFonts: async () =>
        ['Inter Variable', 'JetBrains Mono', 'JetBrainsMono Nerd Font Mono'].map((family) => ({
          family,
        })),
    })
    settingsInit = useSettingsStore.getState()
    uiInit = useUIStore.getState()
    pluginsInit = usePluginsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    useUIStore.setState(uiInit, true)
    usePluginsStore.setState(pluginsInit, true)
    vi.restoreAllMocks()
  })

  it('renders the settings surface with its section nav and the Appearance pane by default', () => {
    renderSettings()

    expect(screen.getByRole('region', { name: 'Settings' })).toBeInTheDocument()

    for (const name of ['Appearance', 'Terminal', 'Files', 'Language', 'About']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: 'Open settings file' })).toBeInTheDocument()

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

    for (const name of ['One Dark Vivid', 'Dracula', 'Test Theme']) {
      expect(await screen.findByRole('option', { name })).toBeInTheDocument()
    }

    await user.click(screen.getByRole('option', { name: 'Test Theme' }))

    expect(setTheme).toHaveBeenCalledWith('test-theme')
  })

  it('reflects the current theme in the theme picker trigger', () => {
    useSettingsStore.setState((s) => ({ appearance: { ...s.appearance, theme: 'oxocarbon' } }))
    renderSettings()

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

    expect(await screen.findByRole('option', { name: 'English' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: '繁體中文' }))

    expect(setLocale).toHaveBeenCalledWith('zh-Hant')
  })

  it('toggles Show hidden files (Files section) via setBehavior with the right patch', async () => {
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

  it('picks a font family by searching the installed fonts', async () => {
    const setSurfaceFont = vi
      .spyOn(useSettingsStore.getState(), 'setSurfaceFont')
      .mockImplementation(() => {})
    renderSettings()
    const user = userEvent.setup()

    const family = screen.getByRole('combobox', { name: 'Terminal font, Family' })
    await user.click(family)
    await user.clear(family)
    await user.type(family, 'nerd')
    expect(screen.queryByRole('option', { name: 'Inter Variable' })).toBeNull()
    await user.click(await screen.findByRole('option', { name: 'JetBrainsMono Nerd Font Mono' }))

    expect(setSurfaceFont).toHaveBeenCalledWith('terminal', {
      family: 'JetBrainsMono Nerd Font Mono',
    })
  })

  it('warns when the chosen font is not installed', async () => {
    renderSettings()
    const user = userEvent.setup()
    await user.click(screen.getByRole('combobox', { name: 'Terminal font, Family' }))
    expect(await screen.findByText('Not installed; a fallback font is used')).toBeInTheDocument()
  })

  it('changes a font weight via setSurfaceFont', async () => {
    const setSurfaceFont = vi
      .spyOn(useSettingsStore.getState(), 'setSurfaceFont')
      .mockImplementation(() => {})
    renderSettings()
    const user = userEvent.setup()
    await user.click(screen.getByRole('combobox', { name: 'UI font, Weight' }))
    await user.click(await screen.findByRole('option', { name: '600' }))
    expect(setSurfaceFont).toHaveBeenCalledWith('ui', { weight: 600 })
  })

  it('changes a font size via setSurfaceFont, clamping to the 8–32 range', () => {
    const setSurfaceFont = vi
      .spyOn(useSettingsStore.getState(), 'setSurfaceFont')
      .mockImplementation(() => {})
    renderSettings()
    const sizeInput = screen.getByRole('spinbutton', { name: 'Terminal font, Size' })

    fireEvent.change(sizeInput, { target: { value: '18' } })
    expect(setSurfaceFont).toHaveBeenLastCalledWith('terminal', { size: 18 })

    fireEvent.change(sizeInput, { target: { value: '99' } })
    expect(setSurfaceFont).toHaveBeenLastCalledWith('terminal', { size: 32 })

    fireEvent.change(sizeInput, { target: { value: '1' } })
    expect(setSurfaceFont).toHaveBeenLastCalledWith('terminal', { size: 8 })
  })

  it('reflects the current appearance settings in the controls', () => {
    useSettingsStore.setState((s) => ({
      appearance: {
        ...s.appearance,
        theme: 'dracula',
        ui: { family: 'Comic Code', size: 20, weight: 500 },
      },
    }))
    renderSettings()

    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveTextContent('Dracula')
    expect(screen.getByRole('combobox', { name: 'UI font, Family' })).toHaveValue('Comic Code')
    expect(screen.getByRole('combobox', { name: 'UI font, Weight' })).toHaveTextContent('500')
    expect(screen.getByRole('spinbutton', { name: 'UI font, Size' })).toHaveValue(20)
  })

  it('shows the version on About and copies it', async () => {
    renderSettings()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'About' }))
    expect(await screen.findByText('v0.0.0')).toBeInTheDocument()
    expect(screen.getByText(`Copyright ${new Date().getFullYear()} pine`)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy version' }))
    expect(await navigator.clipboard.readText()).toBe('v0.0.0')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('exposes accessible names on its controls (a11y)', async () => {
    renderSettings()
    const user = userEvent.setup()

    expect(screen.getByRole('combobox', { name: 'Theme' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'UI font, Family' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'UI font, Size' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Files' }))
    expect(screen.getByRole('switch', { name: 'Show hidden files' })).toBeInTheDocument()
  })
})

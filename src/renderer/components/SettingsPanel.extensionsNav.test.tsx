import '@testing-library/jest-dom/vitest'
import type { ExtensionInfo } from '@shared/extensions'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installLocalStorage } from '../../../test/mocks/memoryStorage'
import { EXTENSIONS_NAV_EXPANDED_KEY } from '../lib/settingsNav'
import { useExtensionsStore } from '../stores/extensionsStore'
import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { SettingsPanel } from './SettingsPanel'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

function ext(id: string, name: string, overrides: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    id,
    name,
    version: '1.0.0',
    description: '',
    builtin: true,
    enabled: true,
    status: 'running',
    requested: [],
    granted: [],
    unapproved: [],
    commands: [],
    panel: null,
    paneChips: [],
    workspaceChips: [],
    settings: [],
    settingValues: {},
    assist: [],
    secrets: [],
    secretsSet: [],
    category: 'other',
    languages: [],
    languageServers: [],
    iconThemes: [],
    ...overrides,
  }
}

const PORTS = ext('ports', 'Ports', {
  settings: [
    {
      key: 'intervalSeconds',
      type: 'number',
      title: 'Scan interval',
      default: 3,
      description: 'Time between scans',
    },
  ],
  settingValues: { intervalSeconds: 3 },
})
const GIT = ext('git', 'Git', { panel: { title: 'Git', icon: 'git-branch' } })

function renderSettings(): void {
  useUIStore.setState({ settingsActive: true, settingsTabOpen: true })
  render(<SettingsPanel />)
}

function nav(): HTMLElement {
  return screen.getByRole('navigation')
}

function disclosure(): HTMLElement {
  return within(nav()).getByRole('button', { name: 'Installed extensions' })
}

describe('SettingsPanel extensions nav', () => {
  let uiInit: ReturnType<typeof useUIStore.getState>
  let pluginsInit: ReturnType<typeof usePluginsStore.getState>
  let extensionsInit: ReturnType<typeof useExtensionsStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    uiInit = useUIStore.getState()
    pluginsInit = usePluginsStore.getState()
    extensionsInit = useExtensionsStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  beforeEach(() => {
    installLocalStorage()
    useExtensionsStore.setState({ list: [PORTS, GIT] })
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    useUIStore.setState(uiInit, true)
    usePluginsStore.setState(pluginsInit, true)
    useExtensionsStore.setState(extensionsInit, true)
    useSettingsStore.setState(settingsInit, true)
    vi.restoreAllMocks()
  })

  it('expands Extensions into one entry per extension and remembers it', async () => {
    renderSettings()
    const user = userEvent.setup()
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false')
    expect(within(nav()).queryByRole('button', { name: 'Ports' })).toBeNull()

    await user.click(disclosure())

    expect(disclosure()).toHaveAttribute('aria-expanded', 'true')
    const list = within(nav()).getByRole('list', { name: 'Installed extensions' })
    expect(disclosure()).toHaveAttribute('aria-controls', list.id)
    expect(within(list).getByRole('button', { name: 'Ports' })).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: 'Git' }).querySelector('svg')).not.toBeNull()
    expect(window.localStorage.getItem(EXTENSIONS_NAV_EXPANDED_KEY)).toBe('true')

    cleanup()
    renderSettings()
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true')
    expect(within(nav()).getByRole('button', { name: 'Ports' })).toBeInTheDocument()
  })

  it('opens Extensions scrolled to the extension a child entry names, and highlights it', async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    window.localStorage.setItem(EXTENSIONS_NAV_EXPANDED_KEY, 'true')
    renderSettings()
    const user = userEvent.setup()

    await user.click(within(nav()).getByRole('button', { name: 'Ports' }))

    expect(screen.getByRole('heading', { level: 2, name: 'Extensions' })).toBeInTheDocument()
    const block = document.getElementById('settings-extension-ports')
    expect(block).not.toBeNull()
    expect(scrolled.mock.contexts).toContain(block)
    expect(block).toHaveFocus()
    expect(within(block as HTMLElement).getByTestId('extension-anchor-highlight')).toHaveClass(
      'settings-anchor-highlight',
    )
    expect(within(nav()).getByRole('button', { name: 'Ports' })).toHaveAttribute(
      'aria-current',
      'location',
    )
    expect(within(nav()).getByRole('button', { name: 'Extensions' })).not.toHaveAttribute(
      'aria-current',
    )
  })

  it('clears the highlight after a moment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      window.localStorage.setItem(EXTENSIONS_NAV_EXPANDED_KEY, 'true')
      renderSettings()
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      await user.click(within(nav()).getByRole('button', { name: 'Git' }))
      expect(screen.getByTestId('extension-anchor-highlight')).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(screen.queryByTestId('extension-anchor-highlight')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('expands and collapses from the keyboard and walks back from a child to Extensions', async () => {
    renderSettings()
    const user = userEvent.setup()
    const extensionsButton = within(nav()).getByRole('button', { name: 'Extensions' })
    extensionsButton.focus()

    await user.keyboard('{ArrowRight}')
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{ArrowLeft}')
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false')

    await user.tab()
    expect(disclosure()).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true')

    await user.tab()
    const ports = within(nav()).getByRole('button', { name: 'Ports' })
    expect(ports).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(document.getElementById('settings-extension-ports')).toHaveFocus()

    ports.focus()
    await user.keyboard('{ArrowLeft}')
    expect(extensionsButton).toHaveFocus()
  })

  it('anchors to an extension from a deep link, in either form', () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    renderSettings()

    act(() => useUIStore.getState().openSettings('extensions/git'))

    expect(screen.getByRole('heading', { level: 2, name: 'Extensions' })).toBeInTheDocument()
    expect(scrolled.mock.contexts).toContain(document.getElementById('settings-extension-git'))
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true')
    expect(within(nav()).getByRole('button', { name: 'Git' })).toHaveAttribute(
      'aria-current',
      'location',
    )
    expect(useUIStore.getState().settingsExtension).toBeNull()

    act(() => useUIStore.getState().openSettings('extensions', { extension: 'ports' }))

    expect(scrolled.mock.contexts).toContain(document.getElementById('settings-extension-ports'))
    expect(within(nav()).getByRole('button', { name: 'Ports' })).toHaveAttribute(
      'aria-current',
      'location',
    )
  })

  it('finds an extension by its name or a setting title in the search box', async () => {
    renderSettings()
    const user = userEvent.setup()
    const search = screen.getByRole('textbox', { name: 'Search settings' })

    await user.type(search, 'scan interval')
    expect(within(nav()).getByRole('button', { name: 'Extensions' })).toBeInTheDocument()
    expect(within(nav()).getByRole('button', { name: 'Ports' })).toBeInTheDocument()
    expect(within(nav()).queryByRole('button', { name: 'Git' })).toBeNull()
    expect(within(nav()).queryByRole('button', { name: 'Appearance' })).toBeNull()

    await user.clear(search)
    await user.type(search, 'git')
    expect(within(nav()).getByRole('button', { name: 'Git' })).toBeInTheDocument()
    expect(within(nav()).queryByRole('button', { name: 'Ports' })).toBeNull()

    await user.clear(search)
    await user.type(search, 'no such thing')
    expect(within(nav()).queryByRole('button', { name: 'Extensions' })).toBeNull()
  })
})

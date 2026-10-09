import '@testing-library/jest-dom/vitest'
import { EXTENSIONS_NAV_EXPANDED_KEY } from '@/lib/settingsNav'
import { useExtensionsStore } from '@/stores/extensionsStore'
import { usePluginsStore } from '@/stores/pluginsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import type { ExtensionInfo } from '@shared/extensions'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installLocalStorage } from '../../../../test/mocks/memoryStorage'
import { renderSettled } from '../../../../test/render'
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
    settingsPage: null,
    category: 'other',
    languages: [],
    languageServers: [],
    agentSkills: [],
    agentHooks: [],
    iconThemes: [],
    keymaps: [],
    ...overrides,
  }
}

const PORTS = ext('tunnels', 'Tunnels', {
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
const GIT = ext('vcs', 'Repo', { panel: { title: 'Repo', icon: 'git-branch' } })
const BOARD = ext('board', 'Board', {
  builtin: false,
  settings: [
    {
      key: 'pollSeconds',
      type: 'number',
      title: 'Poll interval',
      default: 5,
      description: 'Time between polls',
    },
  ],
  settingValues: { pollSeconds: 5 },
  settingsPage: { title: 'Board sync', icon: 'kanban' },
})

async function renderSettings(): Promise<void> {
  useUIStore.setState({ settingsActive: true, settingsTabOpen: true })
  await renderSettled(<SettingsPanel />)
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
    await renderSettings()
    const user = userEvent.setup()
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false')
    expect(within(nav()).queryByRole('button', { name: 'Tunnels' })).toBeNull()

    await user.click(disclosure())

    expect(disclosure()).toHaveAttribute('aria-expanded', 'true')
    const list = within(nav()).getByRole('list', { name: 'Installed extensions' })
    expect(disclosure()).toHaveAttribute('aria-controls', list.id)
    expect(within(list).getByRole('button', { name: 'Tunnels' })).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: 'Repo' }).querySelector('svg')).not.toBeNull()
    expect(window.localStorage.getItem(EXTENSIONS_NAV_EXPANDED_KEY)).toBe('true')

    cleanup()
    await renderSettings()
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true')
    expect(within(nav()).getByRole('button', { name: 'Tunnels' })).toBeInTheDocument()
  })

  it('opens Extensions scrolled to the extension a child entry names, and highlights it', async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    window.localStorage.setItem(EXTENSIONS_NAV_EXPANDED_KEY, 'true')
    await renderSettings()
    const user = userEvent.setup()

    await user.click(within(nav()).getByRole('button', { name: 'Tunnels' }))

    expect(screen.getByRole('heading', { level: 2, name: 'Extensions' })).toBeInTheDocument()
    const block = document.getElementById('settings-extension-tunnels')
    expect(block).not.toBeNull()
    expect(scrolled.mock.contexts).toContain(block)
    expect(block).toHaveFocus()
    expect(within(block as HTMLElement).getByTestId('extension-anchor-highlight')).toHaveClass(
      'settings-anchor-highlight',
    )
    expect(within(nav()).getByRole('button', { name: 'Tunnels' })).toHaveAttribute(
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
      await renderSettings()
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      await user.click(within(nav()).getByRole('button', { name: 'Repo' }))
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
    await renderSettings()
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
    const ports = within(nav()).getByRole('button', { name: 'Tunnels' })
    expect(ports).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(document.getElementById('settings-extension-tunnels')).toHaveFocus()

    ports.focus()
    await user.keyboard('{ArrowLeft}')
    expect(extensionsButton).toHaveFocus()
  })

  it('anchors to an extension from a deep link, in either form', async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    await renderSettings()

    act(() => useUIStore.getState().openSettings('extensions/vcs'))

    expect(screen.getByRole('heading', { level: 2, name: 'Extensions' })).toBeInTheDocument()
    expect(scrolled.mock.contexts).toContain(document.getElementById('settings-extension-vcs'))
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true')
    expect(within(nav()).getByRole('button', { name: 'Repo' })).toHaveAttribute(
      'aria-current',
      'location',
    )
    expect(useUIStore.getState().settingsExtension).toBeNull()

    act(() => useUIStore.getState().openSettings('extensions', { extension: 'tunnels' }))

    expect(scrolled.mock.contexts).toContain(document.getElementById('settings-extension-tunnels'))
    expect(within(nav()).getByRole('button', { name: 'Tunnels' })).toHaveAttribute(
      'aria-current',
      'location',
    )
  })

  async function searchFor(text: string): Promise<void> {
    await renderSettings()
    const user = userEvent.setup()
    await user.click(screen.getByRole('textbox', { name: 'Search settings' }))
    await user.paste(text)
  }

  it('finds an extension by a setting title in the search box', async () => {
    await searchFor('scan interval')
    await waitFor(() =>
      expect(within(nav()).queryByRole('button', { name: 'Appearance' })).toBeNull(),
    )
    expect(within(nav()).getByRole('button', { name: 'Extensions' })).toBeInTheDocument()
    expect(within(nav()).getByRole('button', { name: 'Tunnels' })).toBeInTheDocument()
    expect(within(nav()).queryByRole('button', { name: 'Repo' })).toBeNull()
  })

  it('finds an extension by its name in the search box', async () => {
    await searchFor('repo')
    await waitFor(() => expect(within(nav()).queryByRole('button', { name: 'Tunnels' })).toBeNull())
    expect(within(nav()).getByRole('button', { name: 'Repo' })).toBeInTheDocument()
  })

  it('lists no extension when the search matches none', async () => {
    await searchFor('no such thing')
    await waitFor(() =>
      expect(within(nav()).queryByRole('button', { name: 'Extensions' })).toBeNull(),
    )
  })

  it('opens Browse extensions from its own nav entry and from a deep link', async () => {
    await renderSettings()
    const user = userEvent.setup()
    const entry = within(nav()).getByRole('button', { name: 'Browse extensions' })

    await user.click(entry)

    expect(entry).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { level: 2, name: 'Browse extensions' })).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Installed extensions' })).toBeNull()

    await user.click(within(nav()).getByRole('button', { name: 'Extensions' }))
    expect(screen.queryByRole('heading', { level: 2, name: 'Browse extensions' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Marketplaces' })).toBeNull()

    act(() => useUIStore.getState().openSettings('browseExtensions'))
    expect(screen.getByRole('heading', { level: 2, name: 'Browse extensions' })).toBeInTheDocument()
  })

  describe('an extension that asks for its own page', () => {
    beforeEach(() => {
      useExtensionsStore.setState({ list: [PORTS, GIT, BOARD] })
    })

    it('gets its own nav entry that draws the same form', async () => {
      const setSetting = vi.fn(async () => null)
      useExtensionsStore.setState({ setSetting })
      await renderSettings()
      const user = userEvent.setup()
      const entry = within(nav()).getByRole('button', { name: 'Board sync' })
      expect(entry.querySelector('svg')).not.toBeNull()

      await user.click(entry)

      expect(entry).toHaveAttribute('aria-current', 'page')
      expect(screen.getByRole('heading', { level: 2, name: 'Board sync' })).toBeInTheDocument()
      expect(screen.getByText('From the Board extension.')).toBeInTheDocument()
      const field = screen.getByRole('spinbutton', { name: 'Poll interval' })
      await user.clear(field)
      await user.type(field, '9{Enter}')
      expect(setSetting).toHaveBeenCalledWith('board', 'pollSeconds', 9)
    })

    it('leaves a link to the page in its details instead of the form', async () => {
      await renderSettings()
      const user = userEvent.setup()
      await user.click(within(nav()).getByRole('button', { name: 'Extensions' }))
      const list = screen.getByRole('list', { name: 'Installed extensions' })

      const ports = document.getElementById('settings-extension-tunnels') as HTMLElement
      expect(within(ports).getByRole('spinbutton', { name: 'Scan interval' })).toBeInTheDocument()
      await user.click(within(list).getByRole('button', { name: 'Board' }))
      const board = document.getElementById('settings-extension-board') as HTMLElement
      expect(within(board).queryByRole('spinbutton', { name: 'Poll interval' })).toBeNull()

      await user.click(within(board).getByRole('button', { name: 'Open its settings page' }))
      expect(screen.getByRole('heading', { level: 2, name: 'Board sync' })).toBeInTheDocument()
    })

    it('opens the page from a deep link to the extension', async () => {
      await renderSettings()
      act(() => useUIStore.getState().openSettings('extensions/board'))
      expect(screen.getByRole('heading', { level: 2, name: 'Board sync' })).toBeInTheDocument()
      expect(within(nav()).getByRole('button', { name: 'Board sync' })).toHaveAttribute(
        'aria-current',
        'page',
      )
    })

    it('is found by its page title in the search box', async () => {
      await renderSettings()
      const user = userEvent.setup()
      await user.click(screen.getByRole('textbox', { name: 'Search settings' }))
      await user.paste('board sync')
      expect(within(nav()).getByRole('button', { name: 'Board sync' })).toBeInTheDocument()
      expect(within(nav()).queryByRole('button', { name: 'Tunnels' })).toBeNull()
    })

    it('has no entry while main sends no page, and the form stays in its details', async () => {
      useExtensionsStore.setState({
        list: [PORTS, GIT, { ...BOARD, enabled: false, status: 'disabled', settingsPage: null }],
      })
      await renderSettings()
      const user = userEvent.setup()
      expect(within(nav()).queryByRole('button', { name: 'Board sync' })).toBeNull()
      await user.click(within(nav()).getByRole('button', { name: 'Extensions' }))
      await user.click(
        within(screen.getByRole('list', { name: 'Installed extensions' })).getByRole('button', {
          name: 'Board',
        }),
      )
      const board = document.getElementById('settings-extension-board') as HTMLElement
      expect(within(board).getByRole('spinbutton', { name: 'Poll interval' })).toBeInTheDocument()
    })

    it('falls back to Extensions when the open page goes away', async () => {
      await renderSettings()
      const user = userEvent.setup()
      await user.click(within(nav()).getByRole('button', { name: 'Board sync' }))
      act(() =>
        useExtensionsStore.setState({
          list: [PORTS, GIT, { ...BOARD, enabled: false, settingsPage: null }],
        }),
      )
      expect(screen.getByRole('heading', { level: 2, name: 'Extensions' })).toBeInTheDocument()
      expect(within(nav()).queryByRole('button', { name: 'Board sync' })).toBeNull()
    })
  })
})

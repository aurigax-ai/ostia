import type {
  MarketplaceExtension,
  MarketplaceInfo,
  MarketplaceState,
} from '@shared/extensions/marketplace'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useMarketplaceStore } from '@/stores/extensions/marketplaceStore'
import { renderSettled } from '../../../../test/render'
import { BrowseExtensionsDialog } from './BrowseExtensions'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const CODE = 'abcdefghijklmnopqrstuvwx23'

const WEATHER: MarketplaceExtension = {
  id: 'weather',
  name: 'Weather',
  version: '1.1.0',
  description: 'Shows the weather. Updates every hour from the forecast service.',
  category: 'tools',
  icon: 'globe',
  capabilities: ['notify'],
  runsProcess: true,
  agentSkills: [],
  agentHooks: [],
  state: 'available',
}

const GOPLS: MarketplaceExtension = {
  ...WEATHER,
  id: 'lsp-gopls',
  name: 'Go language server',
  description: 'Code intelligence for Go files.',
  category: 'languages',
  icon: undefined,
  capabilities: ['language-server'],
}

const TIDES: MarketplaceExtension = {
  ...WEATHER,
  id: 'tides',
  name: 'Tides',
  description: 'High and low water.',
  state: 'installed',
}

function marketplace(overrides: Partial<MarketplaceInfo> = {}): MarketplaceInfo {
  return {
    id: 'abc123',
    url: 'https://github.com/acme/ext.git',
    name: 'Acme extensions',
    description: 'Tools from Acme',
    problems: [],
    extensions: [WEATHER],
    installs: [],
    unlisted: false,
    official: false,
    downloaded: true,
    ...overrides,
  }
}

const OTHER = marketplace({
  id: 'def456',
  url: 'https://github.com/other/ext.git',
  name: 'Other extensions',
  extensions: [GOPLS],
})

function stateWith(info: MarketplaceInfo, installed: string[] = []): MarketplaceState {
  return { marketplaces: [info], installed, prerelease: [], dev: {} }
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Browse extensions' })
}

function cards(): HTMLElement {
  return within(dialog()).getByRole('list', { name: 'Extensions in your marketplaces' })
}

function cardNames(): string[] {
  return within(cards())
    .getAllByRole('listitem')
    .map((li) => li.getAttribute('aria-label') ?? '')
}

function page(): HTMLElement {
  return within(dialog()).getByTestId('extension-page')
}

async function browse(state: MarketplaceState): Promise<void> {
  vi.mocked(window.ostia.marketplace.list).mockResolvedValue(state)
  useUIStore.setState({ browseExtensionsOpen: true })
  await renderSettled(<BrowseExtensionsDialog />)
}

describe('BrowseExtensionsDialog', () => {
  let init: ReturnType<typeof useMarketplaceStore.getState>
  let extInit: ReturnType<typeof useExtensionsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    init = useMarketplaceStore.getState()
    extInit = useExtensionsStore.getState()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    cleanup()
    useMarketplaceStore.setState(init, true)
    useExtensionsStore.setState(extInit, true)
    useUIStore.setState(uiInit, true)
  })

  it('lists a card for every extension of every marketplace and opens the first one', async () => {
    await browse({ marketplaces: [marketplace(), OTHER], installed: [], prerelease: [], dev: {} })

    expect(cardNames()).toEqual(['Weather', 'Go language server'])
    const first = within(cards()).getByRole('listitem', { name: 'Weather' })
    expect(first).toHaveAttribute('aria-current', 'true')
    expect(within(first).getByText(/^Shows the weather\./)).toBeVisible()
    expect(within(dialog()).getByRole('heading', { level: 2, name: 'Weather' })).toBeVisible()
  })

  it('shows the page of the picked card with what it asks to do, in plain words', async () => {
    const kit: MarketplaceExtension = {
      ...GOPLS,
      id: 'kit',
      name: 'Kit',
      capabilities: ['language-server', 'agent-plugin'],
      agentSkills: ['kit-review'],
      agentHooks: [{ event: 'SessionStart', command: 'Kit: record' }],
    }
    await browse({
      marketplaces: [marketplace({ extensions: [WEATHER, kit] })],
      installed: [],
      prerelease: [],
      dev: {},
    })

    await userEvent.click(within(cards()).getByRole('listitem', { name: 'Kit' }))

    const pane = within(page())
    expect(pane.getByRole('heading', { level: 2, name: 'Kit' })).toBeVisible()
    expect(pane.getByText('Languages · 1.1.0 · From Acme extensions')).toBeVisible()
    expect(pane.getByText('Code intelligence for Go files.')).toBeVisible()
    expect(pane.getByText('It asks to')).toBeVisible()
    expect(pane.getByText('Run language servers for code intelligence in the editor')).toBeVisible()
    expect(
      pane.getByText('Add skills and hooks to claude and codex in your terminals'),
    ).toBeVisible()
    expect(pane.getByText('Runs a program on this computer')).toBeVisible()
    expect(pane.getByText('Agent skills: kit-review')).toBeVisible()
    expect(pane.getByText('Hook SessionStart runs “Kit: record”')).toBeVisible()
  })

  it('says a data-only extension runs no program', async () => {
    await browse(
      stateWith(
        marketplace({ extensions: [{ ...WEATHER, runsProcess: false, capabilities: [] }] }),
      ),
    )

    expect(within(page()).getByText('No extra permissions')).toBeVisible()
    expect(within(page()).getByText('Data only, runs no program')).toBeVisible()
  })

  it('searches every marketplace by name, summary, category and id', async () => {
    await browse({ marketplaces: [marketplace(), OTHER], installed: [], prerelease: [], dev: {} })
    const search = within(dialog()).getByRole('searchbox', { name: 'Search extensions' })
    const searchFor = async (text: string): Promise<void> => {
      await userEvent.clear(search)
      await userEvent.type(search, text)
    }

    await searchFor('go language')
    expect(cardNames()).toEqual(['Go language server'])
    await searchFor('forecast')
    expect(cardNames()).toEqual(['Weather'])
    await searchFor('languages')
    expect(cardNames()).toEqual(['Go language server'])
    await searchFor('tools')
    expect(cardNames()).toEqual(['Weather'])
    await searchFor('lsp-gopls')
    expect(cardNames()).toEqual(['Go language server'])
    await searchFor('nothing like this')
    expect(within(dialog()).getAllByText('No extension matches.')[0]).toBeVisible()
  })

  it('filters by install state with the update count, and by category', async () => {
    const update: MarketplaceExtension = {
      ...WEATHER,
      id: 'radar',
      name: 'Radar',
      state: 'update',
      installedVersion: '1.0.0',
    }
    await browse({
      marketplaces: [marketplace({ extensions: [WEATHER, TIDES, update] }), OTHER],
      installed: ['tides', 'radar'],
      prerelease: [],
      dev: {},
    })
    const filters = within(dialog()).getByRole('group', { name: 'Show' })
    const pick = async (name: string): Promise<void> => {
      await userEvent.click(within(filters).getByRole('button', { name }))
    }

    await pick('Installed')
    expect(within(filters).getByRole('button', { name: 'Installed' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(cardNames()).toEqual(['Tides', 'Radar'])
    await pick('Updates 1')
    expect(cardNames()).toEqual(['Radar'])
    expect(within(filters).queryByRole('button', { name: 'Not installed' })).toBeNull()
    await pick('All')
    expect(cardNames()).toEqual(['Weather', 'Tides', 'Radar', 'Go language server'])

    await userEvent.click(within(dialog()).getByRole('combobox', { name: 'Category' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Languages' }))
    await waitFor(() => expect(cardNames()).toEqual(['Go language server']))
  })

  it('installs from the page, then says it waits for approval and links to it on Extensions', async () => {
    await browse(stateWith(marketplace()))
    vi.mocked(window.ostia.marketplace.install).mockResolvedValue({
      ok: true,
      state: stateWith(marketplace({ extensions: [{ ...WEATHER, state: 'installed' }] }), [
        'weather',
      ]),
    })

    await userEvent.click(within(page()).getByRole('button', { name: 'Install' }))

    expect(window.ostia.marketplace.install).toHaveBeenCalledWith('abc123', 'weather')
    const note = await screen.findByRole('status')
    expect(note).toHaveTextContent('Weather is installed and waits for your approval.')
    const card = within(cards()).getByRole('listitem', { name: 'Weather' })
    expect(within(card).getByText('Installed')).toBeVisible()
    expect(within(page()).getByRole('button', { name: 'Uninstall' })).toBeVisible()
    expect(useExtensionsStore.getState().list).toEqual([])

    await userEvent.click(within(note).getByRole('button', { name: 'Open in Extensions' }))
    expect(useUIStore.getState().settingsSection).toBe('extensions')
    expect(useUIStore.getState().settingsExtension).toBe('weather')
    expect(useUIStore.getState().browseExtensionsOpen).toBe(false)
  })

  it('shows an extension that needs a newer app with the API it needs, and offers no install', async () => {
    await browse(
      stateWith(
        marketplace({
          extensions: [{ ...WEATHER, state: 'incompatible', needsApi: '9.1' }],
        }),
      ),
    )
    const card = within(cards()).getByRole('listitem', { name: 'Weather' })
    expect(within(card).getByText('Needs newer Ostia')).toBeVisible()
    expect(
      within(page()).getByText('Needs a newer Ostia (extension API 9.1 or later).'),
    ).toBeVisible()
    expect(within(page()).queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('warns when the installed version was withdrawn', async () => {
    await browse(
      stateWith(
        marketplace({ extensions: [{ ...WEATHER, state: 'installed', installedRevoked: true }] }),
        ['weather'],
      ),
    )
    expect(
      within(page()).getByText(
        'This version was withdrawn by its publisher. Update it or uninstall it.',
      ),
    ).toBeVisible()
  })

  it('asks before it switches a pre-release to an older stable version', async () => {
    await browse(
      stateWith(
        marketplace({
          extensions: [
            {
              ...WEATHER,
              version: '1.0.0',
              state: 'update',
              installedVersion: '1.1.0-rc.1',
              downgrade: true,
            },
          ],
        }),
        ['weather'],
      ),
    )
    vi.mocked(window.ostia.marketplace.install).mockResolvedValue({
      ok: true,
      state: stateWith(marketplace({ extensions: [{ ...WEATHER, state: 'installed' }] }), [
        'weather',
      ]),
    })
    await userEvent.click(within(page()).getByRole('button', { name: 'Switch to 1.0.0' }))
    expect(window.ostia.marketplace.install).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('Switch “Weather” to 1.0.0?')).toBeVisible()
    await userEvent.click(within(confirm).getByRole('button', { name: 'Switch to 1.0.0' }))
    expect(window.ostia.marketplace.install).toHaveBeenCalledWith('abc123', 'weather', true)
  })

  it('offers an update with the installed and offered versions', async () => {
    const offered = stateWith(
      marketplace({ extensions: [{ ...WEATHER, state: 'update', installedVersion: '1.0.0' }] }),
      ['weather'],
    )
    await browse(offered)
    vi.mocked(window.ostia.marketplace.install).mockResolvedValue({ ok: true, state: offered })

    const card = within(cards()).getByRole('listitem', { name: 'Weather' })
    expect(within(card).getByText('Update available')).toBeVisible()
    expect(within(page()).getByText(/Installed 1\.0\.0, offered 1\.1\.0/)).toBeVisible()
    expect(within(page()).getByRole('button', { name: 'Uninstall' })).toBeVisible()
    await userEvent.click(within(page()).getByRole('button', { name: 'Update to 1.1.0' }))

    expect(window.ostia.marketplace.install).toHaveBeenCalledWith('abc123', 'weather')
  })

  it('uninstalls from the page after asking', async () => {
    await browse(stateWith(marketplace({ extensions: [TIDES] }), ['tides']))

    await userEvent.click(within(page()).getByRole('button', { name: 'Uninstall' }))

    expect(window.ostia.marketplace.uninstall).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('alertdialog')
    await userEvent.click(within(confirm).getByRole('button', { name: 'Uninstall' }))
    expect(window.ostia.marketplace.uninstall).toHaveBeenCalledWith('tides')
  })

  it('marks an id taken elsewhere as a problem and links to the installed one', async () => {
    await browse(stateWith(marketplace({ extensions: [{ ...WEATHER, state: 'conflict' }] })))

    const card = within(cards()).getByRole('listitem', { name: 'Weather' })
    expect(within(card).getByText('Problem')).toBeVisible()
    expect(within(page()).queryByRole('button', { name: 'Install' })).toBeNull()
    expect(
      within(page()).getByText(
        'An extension with this id is already installed from somewhere else.',
      ),
    ).toBeVisible()
    await userEvent.click(within(page()).getByRole('button', { name: 'Show the installed one' }))
    expect(useUIStore.getState().settingsExtension).toBe('weather')
  })

  it('offers to replace an extension whose marketplace is gone', async () => {
    await browse(
      stateWith(marketplace({ extensions: [{ ...WEATHER, state: 'replace' }] }), ['weather']),
    )

    expect(
      within(page()).getByText('Installed from a marketplace that is no longer added.'),
    ).toBeVisible()
    await userEvent.click(within(page()).getByRole('button', { name: 'Replace with this version' }))
    expect(window.ostia.marketplace.install).toHaveBeenCalledWith('abc123', 'weather')
  })

  it('folds every entry a marketplace could not offer into one line that opens the list', async () => {
    await browse({
      marketplaces: [
        marketplace({
          problems: ['extensions/lsp-bash: Needs extension API 9.0; this provides 4.8'],
        }),
        marketplace({ ...OTHER, problems: ['extensions/broken: missing name'] }),
      ],
      installed: [],
      prerelease: [],
      dev: {},
    })

    await userEvent.click(within(dialog()).getByRole('button', { name: '2 not compatible' }))

    expect(
      within(dialog()).getByRole('heading', { level: 2, name: 'Entries that are not compatible' }),
    ).toBeVisible()
    expect(within(dialog()).getByText('extensions/lsp-bash')).toBeVisible()
    expect(within(dialog()).getByText('Needs extension API 9.0; this provides 4.8')).toBeVisible()
    expect(within(dialog()).getByText('extensions/broken')).toBeVisible()
    expect(within(dialog()).getByText('missing name')).toBeVisible()
  })

  it('shows no not-compatible line when every entry is offered', async () => {
    await browse(stateWith(marketplace()))
    expect(within(dialog()).queryByText(/not compatible/)).toBeNull()
  })

  it('asks to add or download a marketplace when there is nothing to browse', async () => {
    await browse({ marketplaces: [], installed: [], prerelease: [], dev: {} })
    expect(
      within(dialog()).getAllByText('Add a marketplace below to browse its extensions.'),
    ).not.toHaveLength(0)
  })

  it('finds an unlisted extension by a pasted install code and installs it with that code', async () => {
    const info = marketplace({ unlisted: true })
    await browse(stateWith(info))
    vi.mocked(window.ostia.marketplace.findCode).mockResolvedValue({
      ok: true,
      marketplaceId: 'abc123',
      extension: TIDES_AVAILABLE,
    })
    vi.mocked(window.ostia.marketplace.installCode).mockResolvedValue({
      ok: true,
      state: stateWith(marketplace({ unlisted: true, extensions: [WEATHER, TIDES] }), ['tides']),
    })

    await userEvent.type(within(dialog()).getByRole('searchbox'), CODE)

    expect(window.ostia.marketplace.findCode).toHaveBeenLastCalledWith(CODE)
    const card = await within(cards()).findByRole('listitem', { name: 'Tides' })
    expect(within(card).getByText('Unlisted')).toBeVisible()
    expect(within(dialog()).getByText('Install code found in Acme extensions.')).toBeVisible()
    expect(cardNames()).toEqual(['Tides'])

    await userEvent.click(within(page()).getByRole('button', { name: 'Install' }))

    expect(window.ostia.marketplace.installCode).toHaveBeenCalledWith('abc123', CODE)
    expect(window.ostia.marketplace.install).not.toHaveBeenCalled()
  })

  it('shows the unlisted extension of the marketplace that holds the code, not a listed one with the same id', async () => {
    const mine = marketplace({ extensions: [{ ...TIDES, state: 'available' }] })
    const other = marketplace({ ...OTHER, unlisted: true, extensions: [] })
    await browse({ marketplaces: [mine, other], installed: [], prerelease: [], dev: {} })
    vi.mocked(window.ostia.marketplace.findCode).mockResolvedValue({
      ok: true,
      marketplaceId: 'def456',
      extension: { ...TIDES, state: 'available', description: 'The unlisted tides.' },
    })
    vi.mocked(window.ostia.marketplace.installCode).mockResolvedValue({
      ok: true,
      state: { marketplaces: [mine, other], installed: ['tides'], prerelease: [], dev: {} },
    })

    await userEvent.type(within(dialog()).getByRole('searchbox'), CODE)

    const card = await within(cards()).findByRole('listitem', { name: 'Tides' })
    expect(within(card).getByText('Unlisted')).toBeVisible()
    expect(within(page()).getByText('The unlisted tides.')).toBeVisible()
    await userEvent.click(within(page()).getByRole('button', { name: 'Install' }))
    expect(window.ostia.marketplace.installCode).toHaveBeenCalledWith('def456', CODE)
    expect(window.ostia.marketplace.install).not.toHaveBeenCalled()
  })

  it('looks the pasted code up again once a marketplace is added or refreshed', async () => {
    await browse(stateWith(marketplace()))
    vi.mocked(window.ostia.marketplace.findCode).mockResolvedValue({
      ok: false,
      error: 'unknown-code',
    })
    await userEvent.type(within(dialog()).getByRole('searchbox'), CODE)
    await waitFor(() => expect(window.ostia.marketplace.findCode).toHaveBeenCalledTimes(1))

    vi.mocked(window.ostia.marketplace.findCode).mockResolvedValue({
      ok: true,
      marketplaceId: 'def456',
      extension: TIDES_AVAILABLE,
    })
    act(() =>
      useMarketplaceStore.setState({
        state: {
          marketplaces: [marketplace(), { ...OTHER, unlisted: true }],
          installed: [],
          prerelease: [],
          dev: {},
        },
      }),
    )

    expect(await within(dialog()).findByRole('listitem', { name: 'Tides' })).toBeVisible()
    expect(window.ostia.marketplace.findCode).toHaveBeenCalledTimes(2)
  })

  it('says so when no unlisted extension has the pasted code, and looks nothing up for other text', async () => {
    await browse(stateWith(marketplace({ unlisted: true })))
    vi.mocked(window.ostia.marketplace.findCode).mockResolvedValue({
      ok: false,
      error: 'unknown-code',
    })
    const search = within(dialog()).getByRole('searchbox')

    await userEvent.type(search, 'wrong')
    expect(window.ostia.marketplace.findCode).not.toHaveBeenCalled()

    await userEvent.clear(search)
    await userEvent.type(search, CODE)
    expect(
      (await within(dialog()).findAllByText('No unlisted extension has this install code.'))[0],
    ).toBeVisible()
  })

  it('closes from its close button and leaves Settings open', async () => {
    await browse(stateWith(marketplace()))

    await userEvent.click(within(dialog()).getByRole('button', { name: 'Close' }))

    expect(useUIStore.getState().browseExtensionsOpen).toBe(false)
  })
})

const TIDES_AVAILABLE: MarketplaceExtension = { ...TIDES, state: 'available' }

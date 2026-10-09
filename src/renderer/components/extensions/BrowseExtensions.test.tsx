import { useExtensionsStore } from '@/stores/extensionsStore'
import { useMarketplaceStore } from '@/stores/marketplaceStore'
import { useUIStore } from '@/stores/uiStore'
import type { ExtensionInfo } from '@shared/extensions'
import type {
  MarketplaceExtension,
  MarketplaceInfo,
  MarketplaceState,
} from '@shared/extensions/marketplace'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../../test/render'
import { BrowseExtensions } from './BrowseExtensions'
import { ExtensionsSection } from './InstalledExtensions'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

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
  return { marketplaces: [info], installed }
}

const EMPTY: MarketplaceState = { marketplaces: [], installed: [] }

function results(): HTMLElement {
  return screen.getByRole('list', { name: 'Extensions in your marketplaces' })
}

function resultNames(): string[] {
  return within(results())
    .getAllByRole('listitem')
    .map((li) => li.getAttribute('aria-label') ?? '')
}

function details(): HTMLElement {
  return screen.getByRole('region', { name: 'Details' })
}

async function browse(state: MarketplaceState): Promise<void> {
  vi.mocked(window.ostia.marketplace.list).mockResolvedValue(state)
  await renderSettled(<BrowseExtensions />)
}

describe('BrowseExtensions', () => {
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

  it('adds the typed repository and lists what it offers in compact rows', async () => {
    await browse(EMPTY)
    expect(screen.getByText('No marketplaces added.')).toBeVisible()
    expect(screen.getByText('Add a marketplace below to browse its extensions.')).toBeVisible()
    vi.mocked(window.ostia.marketplace.add).mockResolvedValue({
      ok: true,
      state: stateWith(marketplace()),
    })
    await userEvent.type(screen.getByLabelText('Marketplace repository'), 'acme/ext')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(window.ostia.marketplace.add).toHaveBeenCalledWith('acme/ext')
    const row = await within(results()).findByRole('listitem', { name: 'Weather' })
    expect(within(row).getByText('Shows the weather. · Acme extensions')).toBeVisible()
    expect(within(row).getByRole('button', { name: 'Install' })).toBeVisible()
    expect(
      within(screen.getByRole('region', { name: 'Marketplaces' })).getByRole('listitem', {
        name: 'Acme extensions',
      }),
    ).toBeVisible()
    expect(screen.getByLabelText('Marketplace repository')).toHaveValue('')
  })

  it('keeps the typed text and shows why when adding fails', async () => {
    await browse(EMPTY)
    vi.mocked(window.ostia.marketplace.add).mockResolvedValue({
      ok: false,
      error: 'clone-failed',
      detail: 'fatal: repository not found',
      state: EMPTY,
    })
    await userEvent.type(screen.getByLabelText('Marketplace repository'), 'acme/missing')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('git could not download the repository.')).toBeVisible()
    expect(screen.getByText('fatal: repository not found')).toBeVisible()
    expect(screen.getByLabelText('Marketplace repository')).toHaveValue('acme/missing')
  })

  it('searches every marketplace by name, summary, category and id', async () => {
    await browse({ marketplaces: [marketplace(), OTHER], installed: [] })
    expect(resultNames()).toEqual(['Weather', 'Go language server'])
    const search = screen.getByRole('searchbox', { name: 'Search extensions' })
    const searchFor = async (text: string): Promise<void> => {
      await userEvent.clear(search)
      await userEvent.type(search, text)
    }

    await searchFor('go language')
    expect(resultNames()).toEqual(['Go language server'])
    await searchFor('forecast')
    expect(resultNames()).toEqual(['Weather'])
    await searchFor('languages')
    expect(resultNames()).toEqual(['Go language server'])
    await searchFor('tools')
    expect(resultNames()).toEqual(['Weather'])
    await searchFor('lsp-gopls')
    expect(resultNames()).toEqual(['Go language server'])
    await searchFor('nothing like this')
    expect(screen.getByText('No extension matches.')).toBeVisible()
  })

  it('filters by install state and by category', async () => {
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
    })
    const filters = screen.getByRole('group', { name: 'Show' })
    const pick = async (name: string): Promise<void> => {
      await userEvent.click(within(filters).getByRole('button', { name }))
    }

    await pick('Installed')
    expect(within(filters).getByRole('button', { name: 'Installed' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(resultNames()).toEqual(['Tides', 'Radar'])
    await pick('Not installed')
    expect(resultNames()).toEqual(['Weather', 'Go language server'])
    await pick('Updates')
    expect(resultNames()).toEqual(['Radar'])
    await pick('All')
    expect(resultNames()).toEqual(['Weather', 'Tides', 'Radar', 'Go language server'])

    await userEvent.click(screen.getByRole('combobox', { name: 'Category' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Languages' }))
    await waitFor(() => expect(resultNames()).toEqual(['Go language server']))
  })

  it('shows the selected extension’s details with its permissions in plain words', async () => {
    const kit: MarketplaceExtension = {
      ...GOPLS,
      id: 'kit',
      name: 'Kit',
      capabilities: ['language-server', 'agent-plugin'],
      agentSkills: ['kit-review'],
      agentHooks: [{ event: 'SessionStart', command: 'Kit: record' }],
    }
    await browse({ marketplaces: [marketplace({ extensions: [WEATHER, kit] })], installed: [] })
    expect(within(details()).getByRole('heading', { name: 'Weather' })).toBeVisible()

    await userEvent.click(within(results()).getByRole('button', { name: 'Kit' }))

    const pane = details()
    expect(within(pane).getByText('Code intelligence for Go files.')).toBeVisible()
    expect(within(pane).getByText('Version 1.1.0 · From Acme extensions · Languages')).toBeVisible()
    const permissions = within(pane).getByRole('list', { name: 'Permissions it asks for' })
    expect(
      within(permissions)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'language-serverRun language servers for code intelligence in the editor',
      'agent-pluginAdd skills and hooks to claude and codex in your terminals',
    ])
    expect(within(pane).getByText('Agent skills: kit-review')).toBeVisible()
    expect(within(pane).getByText('Hook SessionStart runs “Kit: record”')).toBeVisible()
    expect(within(pane).getByRole('button', { name: 'Install' })).toBeVisible()
  })

  it('installs from a row, then says it waits for approval and links to it on Extensions', async () => {
    await browse(stateWith(marketplace()))
    vi.mocked(window.ostia.marketplace.install).mockResolvedValue({
      ok: true,
      state: stateWith(marketplace({ extensions: [{ ...WEATHER, state: 'installed' }] }), [
        'weather',
      ]),
    })
    const row = within(results()).getByRole('listitem', { name: 'Weather' })
    await userEvent.click(within(row).getByRole('button', { name: 'Install' }))
    expect(window.ostia.marketplace.install).toHaveBeenCalledWith('abc123', 'weather')
    const note = await screen.findByRole('status')
    expect(note).toHaveTextContent('Weather is installed and waits for your approval.')
    expect(within(row).getByText('Installed')).toBeVisible()
    expect(within(row).getByRole('button', { name: 'Uninstall' })).toBeVisible()
    expect(useExtensionsStore.getState().list).toEqual([])

    await userEvent.click(within(note).getByRole('button', { name: 'Open in Extensions' }))
    expect(useUIStore.getState().settingsSection).toBe('extensions')
    expect(useUIStore.getState().settingsExtension).toBe('weather')
  })

  it('installs from the details pane too', async () => {
    await browse(stateWith(marketplace()))
    vi.mocked(window.ostia.marketplace.install).mockResolvedValue({
      ok: true,
      state: stateWith(marketplace()),
    })
    await userEvent.click(within(details()).getByRole('button', { name: 'Install' }))
    expect(window.ostia.marketplace.install).toHaveBeenCalledWith('abc123', 'weather')
  })

  it('offers an update with the installed and offered versions', async () => {
    const offered = stateWith(
      marketplace({ extensions: [{ ...WEATHER, state: 'update', installedVersion: '1.0.0' }] }),
      ['weather'],
    )
    await browse(offered)
    vi.mocked(window.ostia.marketplace.install).mockResolvedValue({ ok: true, state: offered })
    const row = within(results()).getByRole('listitem', { name: 'Weather' })
    expect(within(row).getByText('Update available')).toBeVisible()
    expect(
      within(details()).getByText('Installed 1.0.0, offered 1.1.0 · From Acme extensions · Tools'),
    ).toBeVisible()
    expect(within(details()).getByRole('button', { name: 'Uninstall' })).toBeVisible()
    await userEvent.click(within(details()).getByRole('button', { name: 'Update to 1.1.0' }))
    expect(window.ostia.marketplace.install).toHaveBeenCalledWith('abc123', 'weather')
    vi.mocked(window.ostia.marketplace.install).mockClear()
    await userEvent.click(within(row).getByRole('button', { name: 'Update' }))
    expect(window.ostia.marketplace.install).toHaveBeenCalledWith('abc123', 'weather')
  })

  it('uninstalls from a row after asking', async () => {
    await browse(stateWith(marketplace({ extensions: [TIDES] }), ['tides']))
    const row = within(results()).getByRole('listitem', { name: 'Tides' })
    await userEvent.click(within(row).getByRole('button', { name: 'Uninstall' }))
    expect(window.ostia.marketplace.uninstall).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }))
    expect(window.ostia.marketplace.uninstall).toHaveBeenCalledWith('tides')
  })

  it('marks an id taken elsewhere as a problem and links to the installed one', async () => {
    await browse(
      stateWith(
        marketplace({
          extensions: [{ ...WEATHER, state: 'conflict' }],
          problems: ['extensions/broken: missing name'],
        }),
      ),
    )
    const row = within(results()).getByRole('listitem', { name: 'Weather' })
    expect(within(row).getByText('Problem')).toBeVisible()
    expect(within(row).queryByRole('button', { name: 'Install' })).toBeNull()
    const pane = details()
    expect(
      within(pane).getByText('An extension with this id is already installed from somewhere else.'),
    ).toBeVisible()
    expect(within(pane).queryByRole('button', { name: 'Install' })).toBeNull()
    expect(screen.getByText('extensions/broken: missing name')).toBeVisible()
    await userEvent.click(within(pane).getByRole('button', { name: 'Show the installed one' }))
    expect(useUIStore.getState().settingsExtension).toBe('weather')
  })

  it('offers to replace an extension whose marketplace is gone', async () => {
    await browse(
      stateWith(marketplace({ extensions: [{ ...WEATHER, state: 'replace' }] }), ['weather']),
    )
    expect(
      within(details()).getByText('Installed from a marketplace that is no longer added.'),
    ).toBeVisible()
    await userEvent.click(
      within(details()).getByRole('button', { name: 'Replace with this version' }),
    )
    expect(window.ostia.marketplace.install).toHaveBeenCalledWith('abc123', 'weather')
  })

  it('refreshes and removes a marketplace from its panel', async () => {
    await browse(stateWith(marketplace()))
    vi.mocked(window.ostia.marketplace.refresh).mockResolvedValue({
      ok: true,
      state: stateWith(marketplace()),
    })
    await userEvent.click(screen.getByRole('button', { name: 'Refresh Acme extensions' }))
    expect(window.ostia.marketplace.refresh).toHaveBeenCalledWith('abc123')
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Acme extensions' }))
    expect(window.ostia.marketplace.remove).toHaveBeenCalledWith('abc123', false)
  })

  it('asks whether to keep or uninstall what a removed marketplace installed', async () => {
    await browse(stateWith(marketplace({ installs: ['weather'] }), ['weather']))
    await userEvent.click(screen.getByRole('button', { name: 'Remove Acme extensions' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByText('It installed weather. Keep them, or uninstall them with it?'),
    ).toBeVisible()
    expect(window.ostia.marketplace.remove).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Uninstall them' }))
    expect(window.ostia.marketplace.remove).toHaveBeenCalledWith('abc123', true)
  })

  it('offers the install code field only for a marketplace that has unlisted extensions', async () => {
    await browse(stateWith(marketplace()))
    expect(screen.queryByLabelText('Install code for Acme extensions')).toBeNull()
  })

  it('installs an unlisted extension by the typed code and then lists it', async () => {
    await browse(stateWith(marketplace({ unlisted: true })))
    vi.mocked(window.ostia.marketplace.installCode).mockResolvedValue({
      ok: true,
      state: stateWith(marketplace({ unlisted: true, extensions: [WEATHER, TIDES] }), ['tides']),
    })
    const field = screen.getByLabelText('Install code for Acme extensions')
    const form = field.closest('form') as HTMLFormElement
    expect(within(form).getByRole('button', { name: 'Install' })).toBeDisabled()
    await userEvent.type(field, 'abcdefghijklmnopqrstuvwx23')
    await userEvent.click(within(form).getByRole('button', { name: 'Install' }))
    expect(window.ostia.marketplace.installCode).toHaveBeenCalledWith(
      'abc123',
      'abcdefghijklmnopqrstuvwx23',
    )
    expect(await within(results()).findByRole('listitem', { name: 'Tides' })).toBeVisible()
    expect(field).toHaveValue('')
  })

  it('keeps the typed code and says so when no unlisted extension has it', async () => {
    const info = marketplace({ unlisted: true })
    await browse(stateWith(info))
    vi.mocked(window.ostia.marketplace.installCode).mockResolvedValue({
      ok: false,
      error: 'unknown-code',
      state: stateWith(info),
    })
    const field = screen.getByLabelText('Install code for Acme extensions')
    await userEvent.type(field, 'wrong{Enter}')
    expect(
      await screen.findByText('No unlisted extension in this marketplace has this install code.'),
    ).toBeVisible()
    expect(field).toHaveValue('wrong')
  })
})

describe('Uninstall and source on the Extensions page', () => {
  let init: ReturnType<typeof useMarketplaceStore.getState>
  let extInit: ReturnType<typeof useExtensionsStore.getState>

  beforeAll(() => {
    init = useMarketplaceStore.getState()
    extInit = useExtensionsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useMarketplaceStore.setState(init, true)
    useExtensionsStore.setState(extInit, true)
  })

  function ext(id: string, name: string): ExtensionInfo {
    return {
      id,
      name,
      version: '1.0.0',
      description: '',
      builtin: false,
      enabled: true,
      status: 'idle',
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
    }
  }

  it('shows Uninstall only for marketplace installs and asks before removing', async () => {
    useExtensionsStore.setState({ list: [ext('manual', 'Manual'), ext('weather', 'Weather')] })
    vi.mocked(window.ostia.marketplace.list).mockResolvedValue(
      stateWith(marketplace({ installs: ['weather'] }), ['weather']),
    )
    await renderSettled(<ExtensionsSection />)
    const manual = screen.getByRole('region', { name: 'Manual' })
    expect(within(manual).getByText('1.0.0 · Installed by hand · Other')).toBeVisible()
    expect(within(manual).queryByRole('button', { name: 'Uninstall' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Weather' }))

    const weather = screen.getByRole('region', { name: 'Weather' })
    expect(within(weather).getByText('1.0.0 · From Acme extensions · Other')).toBeVisible()
    await userEvent.click(within(weather).getByRole('button', { name: 'Uninstall' }))
    expect(window.ostia.marketplace.uninstall).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Uninstall “Weather”?')).toBeVisible()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }))
    expect(window.ostia.marketplace.uninstall).toHaveBeenCalledWith('weather')
  })
})

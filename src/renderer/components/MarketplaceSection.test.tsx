import type { ExtensionInfo } from '@shared/extensions'
import type { MarketplaceExtension, MarketplaceInfo, MarketplaceState } from '@shared/marketplace'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useMarketplaceStore } from '../stores/marketplaceStore'
import { MarketplaceSection } from './MarketplaceSection'
import { ExtensionsSection } from './SettingsPanel'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const WEATHER: MarketplaceExtension = {
  id: 'weather',
  name: 'Weather',
  version: '1.1.0',
  description: 'Shows the weather',
  category: 'tools',
  capabilities: ['notify'],
  runsProcess: true,
  state: 'available',
}

function marketplace(overrides: Partial<MarketplaceInfo> = {}): MarketplaceInfo {
  return {
    id: 'abc123',
    url: 'https://github.com/acme/ext.git',
    name: 'Acme extensions',
    description: 'Tools from Acme',
    problems: [],
    extensions: [WEATHER],
    ...overrides,
  }
}

function stateWith(info: MarketplaceInfo, installed: string[] = []): MarketplaceState {
  return { marketplaces: [info], installed }
}

const EMPTY: MarketplaceState = { marketplaces: [], installed: [] }

describe('MarketplaceSection', () => {
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

  it('adds the typed repository and lists what it offers', async () => {
    vi.mocked(window.pine.marketplace.list).mockResolvedValue(EMPTY)
    vi.mocked(window.pine.marketplace.add).mockResolvedValue({
      ok: true,
      state: stateWith(marketplace()),
    })
    render(<MarketplaceSection />)
    expect(await screen.findByText('No marketplaces added.')).toBeVisible()
    await userEvent.type(screen.getByLabelText('Marketplace repository'), 'acme/ext')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(window.pine.marketplace.add).toHaveBeenCalledWith('acme/ext')
    const card = await screen.findByRole('listitem', { name: 'Acme extensions' })
    const row = within(card).getByRole('listitem', { name: 'Weather' })
    expect(
      within(row).getByText('Runs a program on this computer · Permissions: notify'),
    ).toBeVisible()
    expect(within(row).getByText('Tools')).toBeVisible()
    expect(screen.getByLabelText('Marketplace repository')).toHaveValue('')
  })

  it('keeps the typed text and shows why when adding fails', async () => {
    vi.mocked(window.pine.marketplace.list).mockResolvedValue(EMPTY)
    vi.mocked(window.pine.marketplace.add).mockResolvedValue({
      ok: false,
      error: 'clone-failed',
      detail: 'fatal: repository not found',
      state: EMPTY,
    })
    render(<MarketplaceSection />)
    await userEvent.type(screen.getByLabelText('Marketplace repository'), 'acme/missing')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('git could not download the repository.')).toBeVisible()
    expect(screen.getByText('fatal: repository not found')).toBeVisible()
    expect(screen.getByLabelText('Marketplace repository')).toHaveValue('acme/missing')
  })

  it('installs an available extension and then shows it as installed', async () => {
    const offered = marketplace()
    const installed = marketplace({
      extensions: [{ ...WEATHER, state: 'installed' }],
    })
    vi.mocked(window.pine.marketplace.list).mockResolvedValue(stateWith(offered))
    vi.mocked(window.pine.marketplace.install).mockResolvedValue({
      ok: true,
      state: stateWith(installed, ['weather']),
    })
    render(<MarketplaceSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Install' }))
    expect(window.pine.marketplace.install).toHaveBeenCalledWith('abc123', 'weather')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install' })).toBeNull())
    expect(screen.getByText('Installed')).toBeVisible()
  })

  it('offers an update when the marketplace has a newer version', async () => {
    vi.mocked(window.pine.marketplace.list).mockResolvedValue(
      stateWith(
        marketplace({
          extensions: [{ ...WEATHER, state: 'update', installedVersion: '1.0.0' }],
        }),
        ['weather'],
      ),
    )
    render(<MarketplaceSection />)
    expect(await screen.findByText('Installed 1.0.0')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Update to 1.1.0' }))
    expect(window.pine.marketplace.install).toHaveBeenCalledWith('abc123', 'weather')
  })

  it('offers no install for an id that is already taken, and shows broken entries', async () => {
    vi.mocked(window.pine.marketplace.list).mockResolvedValue(
      stateWith(
        marketplace({
          extensions: [{ ...WEATHER, state: 'conflict' }],
          problems: ['extensions/broken: missing name'],
        }),
      ),
    )
    render(<MarketplaceSection />)
    expect(
      await screen.findByText(
        'An extension with this id is already installed from somewhere else.',
      ),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
    expect(screen.getByText('extensions/broken: missing name')).toBeVisible()
  })

  it('refreshes and removes a marketplace from its buttons', async () => {
    vi.mocked(window.pine.marketplace.list).mockResolvedValue(stateWith(marketplace()))
    vi.mocked(window.pine.marketplace.refresh).mockResolvedValue({
      ok: true,
      state: stateWith(marketplace()),
    })
    render(<MarketplaceSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Refresh Acme extensions' }))
    expect(window.pine.marketplace.refresh).toHaveBeenCalledWith('abc123')
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Acme extensions' }))
    expect(window.pine.marketplace.remove).toHaveBeenCalledWith('abc123')
  })
})

describe('Uninstall in the installed list', () => {
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
      settings: [],
      settingValues: {},
      assist: [],
      secrets: [],
      secretsSet: [],
      category: 'other',
      iconThemes: [],
    }
  }

  it('shows Uninstall only for marketplace installs and asks before removing', async () => {
    useExtensionsStore.setState({ list: [ext('weather', 'Weather'), ext('manual', 'Manual')] })
    useMarketplaceStore.setState({ state: { marketplaces: [], installed: ['weather'] } })
    render(<ExtensionsSection />)
    const manual = screen.getByRole('listitem', { name: 'Manual' })
    expect(within(manual).queryByRole('button', { name: 'Uninstall' })).toBeNull()
    const weather = screen.getByRole('listitem', { name: 'Weather' })
    await userEvent.click(within(weather).getByRole('button', { name: 'Uninstall' }))
    expect(window.pine.marketplace.uninstall).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Uninstall “Weather”?')).toBeVisible()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }))
    expect(window.pine.marketplace.uninstall).toHaveBeenCalledWith('weather')
  })
})

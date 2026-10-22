import type { MarketplaceInfo, MarketplaceState } from '@shared/extensions/marketplace'
import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useMarketplaceStore } from '@/stores/extensions/marketplaceStore'
import { renderSettled } from '../../../../test/render'
import { MarketplacesGroup } from './MarketplaceSection'

function marketplace(overrides: Partial<MarketplaceInfo> = {}): MarketplaceInfo {
  return {
    id: 'abc123',
    url: 'https://github.com/acme/ext.git',
    name: 'Acme extensions',
    description: 'Tools from Acme',
    problems: [],
    extensions: [],
    installs: [],
    unlisted: false,
    official: false,
    downloaded: true,
    ...overrides,
  }
}

const EMPTY: MarketplaceState = { marketplaces: [], installed: [], prerelease: [], dev: {} }

function stateWith(info: MarketplaceInfo, installed: string[] = []): MarketplaceState {
  return { marketplaces: [info], installed, prerelease: [], dev: {} }
}

function marketplaceList(): HTMLElement {
  return screen.getByRole('list', { name: 'Marketplaces' })
}

async function show(state: MarketplaceState): Promise<void> {
  vi.mocked(window.ostia.marketplace.list).mockResolvedValue(state)
  await renderSettled(<MarketplacesGroup />)
}

describe('MarketplacesGroup', () => {
  let init: ReturnType<typeof useMarketplaceStore.getState>

  beforeAll(() => {
    init = useMarketplaceStore.getState()
  })

  afterEach(() => {
    cleanup()
    useMarketplaceStore.setState(init, true)
  })

  it('puts the add field on the first row and adds the typed repository', async () => {
    await show(EMPTY)
    const addRow = screen.getByText('Add a marketplace')
    expect(addRow.compareDocumentPosition(screen.getByText('No marketplaces added.'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    vi.mocked(window.ostia.marketplace.add).mockResolvedValue({
      ok: true,
      state: stateWith(marketplace()),
    })

    await userEvent.type(screen.getByLabelText('Marketplace repository'), 'acme/ext')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(window.ostia.marketplace.add).toHaveBeenCalledWith('acme/ext')
    expect(
      await within(marketplaceList()).findByRole('listitem', { name: 'Acme extensions' }),
    ).toBeVisible()
    expect(screen.getByLabelText('Marketplace repository')).toHaveValue('')
  })

  it('installs a development copy from a folder or a git branch, enabled only for a source it can read', async () => {
    await show(EMPTY)
    vi.mocked(window.ostia.marketplace.installDev).mockResolvedValue({ ok: true, state: EMPTY })
    const field = screen.getByLabelText('Development copy')
    const install = screen.getAllByRole('button', { name: 'Install' })[0] as HTMLElement
    expect(install).toBeDisabled()

    await userEvent.type(field, 'not a source')
    expect(install).toBeDisabled()
    await userEvent.clear(field)
    await userEvent.type(field, '/home/me/ext')
    await userEvent.click(install)
    expect(window.ostia.marketplace.installDev).toHaveBeenLastCalledWith({
      kind: 'folder',
      path: '/home/me/ext',
    })
    expect(field).toHaveValue('')

    await userEvent.type(field, 'acme/ext#fix/x:src')
    await userEvent.click(install)
    expect(window.ostia.marketplace.installDev).toHaveBeenLastCalledWith({
      kind: 'git',
      url: 'acme/ext',
      branch: 'fix/x',
      path: 'src',
    })
  })

  it('keeps the typed text and shows why when adding fails', async () => {
    await show(EMPTY)
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

  it('lists the official marketplace first as {product} extensions with its url, also before the download', async () => {
    const url = 'https://github.com/aurigax-ai/ostia-extensions.git'
    const pending = marketplace({
      id: 'official',
      name: url,
      url,
      description: '',
      official: true,
      downloaded: false,
    })
    await show({ marketplaces: [pending, marketplace()], installed: [], prerelease: [], dev: {} })

    const names = within(marketplaceList())
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('aria-label'))
    expect(names).toEqual(['Ostia extensions', 'Acme extensions'])
    const row = within(marketplaceList()).getByRole('listitem', { name: 'Ostia extensions' })
    expect(within(row).getByText(url)).toBeVisible()
    expect(within(row).getByText('Not downloaded yet.')).toBeVisible()
    expect(within(row).queryByText('This marketplace lists no extensions.')).toBeNull()
    expect(within(row).queryByRole('button', { name: /^Remove/ })).toBeNull()
    vi.mocked(window.ostia.marketplace.refresh).mockResolvedValue({
      ok: true,
      state: stateWith(marketplace({ id: 'official', official: true })),
    })
    await userEvent.click(within(row).getByRole('button', { name: 'Download' }))
    expect(window.ostia.marketplace.refresh).toHaveBeenCalledWith('official')
  })

  it('prints a marketplace url once when it is also the name', async () => {
    const url = 'https://github.com/acme/new.git'
    await show(stateWith(marketplace({ name: url, url, downloaded: false })))
    expect(screen.getAllByText(url)).toHaveLength(1)
  })

  it('has no remove button for the official marketplace and no line to add it', async () => {
    await show({
      marketplaces: [
        marketplace({ id: 'o', name: 'Official catalogue', official: true }),
        marketplace(),
      ],
      installed: [],
      prerelease: [],
      dev: {},
    })
    const panel = marketplaceList()
    expect(within(panel).getByRole('button', { name: 'Remove Acme extensions' })).toBeVisible()
    expect(within(panel).queryByRole('button', { name: 'Remove Ostia extensions' })).toBeNull()
    expect(within(panel).getByRole('listitem', { name: 'Ostia extensions' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Add the official marketplace' })).toBeNull()
  })

  it('refreshes and removes a marketplace from its row', async () => {
    await show(stateWith(marketplace()))
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
    await show(stateWith(marketplace({ installs: ['weather'] }), ['weather']))

    await userEvent.click(screen.getByRole('button', { name: 'Remove Acme extensions' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByText('It installed weather. Keep them, or uninstall them with it?'),
    ).toBeVisible()
    expect(window.ostia.marketplace.remove).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Uninstall them' }))
    expect(window.ostia.marketplace.remove).toHaveBeenCalledWith('abc123', true)
  })

  it('has no install code field, even for a marketplace with unlisted extensions', async () => {
    await show(stateWith(marketplace({ unlisted: true })))
    expect(screen.queryByLabelText(/Install code/)).toBeNull()
  })
})

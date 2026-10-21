import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type {
  MarketplaceExtension,
  MarketplaceInfo,
  MarketplaceState,
} from '@shared/extensions/marketplace'
import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useMarketplaceStore } from '@/stores/extensions/marketplaceStore'
import { renderSettled } from '../../../../test/render'
import { ExtensionsSection } from './InstalledExtensions'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

function ext(id: string, name: string, over: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    id,
    name,
    version: '1.0.0',
    description: `${name} does a thing. More words follow.`,
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
    connectionKinds: [],
    settingsPage: null,
    category: 'other',
    languages: [],
    languageServers: [],
    fileKinds: [],
    agentSkills: [],
    agentSkillProblems: [],
    agentHooks: [],
    iconThemes: [],
    keymaps: [],
    ...over,
  }
}

const WEATHER: MarketplaceExtension = {
  id: 'weather',
  name: 'Weather',
  version: '1.0.0',
  description: 'Shows the weather.',
  category: 'tools',
  capabilities: [],
  runsProcess: false,
  agentSkills: [],
  agentHooks: [],
  state: 'installed',
}

function marketplace(extensions: MarketplaceExtension[]): MarketplaceInfo {
  return {
    id: 'abc123',
    url: 'https://github.com/acme/ext.git',
    name: 'Acme extensions',
    description: '',
    problems: [],
    extensions,
    installs: extensions.map((e) => e.id),
    unlisted: false,
    official: false,
    downloaded: true,
  }
}

function stateWith(extensions: MarketplaceExtension[]): MarketplaceState {
  return { marketplaces: [marketplace(extensions)], installed: extensions.map((e) => e.id) }
}

describe('ExtensionsSection rows', () => {
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

  async function show(list: ExtensionInfo[], state: MarketplaceState): Promise<void> {
    useExtensionsStore.setState({ list })
    vi.mocked(window.ostia.marketplace.list).mockResolvedValue(state)
    await renderSettled(<ExtensionsSection />)
  }

  it('names each extension with its version and source and one line of what it does', async () => {
    await show(
      [
        ext('manual', 'Manual'),
        ext('weather', 'Weather'),
        ext('notes', 'Notes', { builtin: true }),
      ],
      stateWith([WEATHER]),
    )

    const manual = screen.getByRole('listitem', { name: 'Manual' })
    expect(within(manual).getByText('1.0.0 · Installed by hand')).toBeVisible()
    expect(within(manual).getByText('Manual does a thing.')).toBeVisible()
    expect(
      within(screen.getByRole('listitem', { name: 'Weather' })).getByText(
        '1.0.0 · From Acme extensions',
      ),
    ).toBeVisible()
    expect(
      within(screen.getByRole('listitem', { name: 'Notes' })).getByText('1.0.0 · Built in'),
    ).toBeVisible()
  })

  it('opens an extension’s details from its gear and offers Uninstall only for marketplace installs', async () => {
    await show([ext('manual', 'Manual'), ext('weather', 'Weather')], stateWith([WEATHER]))
    const user = userEvent.setup()

    expect(
      within(screen.getByRole('listitem', { name: 'Manual' })).queryByRole('button', {
        name: 'Uninstall Manual',
      }),
    ).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Settings of Manual' }))
    const manual = screen.getByRole('region', { name: 'Settings of Manual' })
    expect(within(manual).getByText('Other')).toBeVisible()

    const row = screen.getByRole('listitem', { name: 'Weather' })
    await user.click(within(row).getByRole('button', { name: 'Uninstall Weather' }))
    expect(window.ostia.marketplace.uninstall).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Uninstall “Weather”?')).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Uninstall' }))
    expect(window.ostia.marketplace.uninstall).toHaveBeenCalledWith('weather')
  })

  it('lists the language servers of an extension in its details and not in the others', async () => {
    vi.mocked(window.ostia.lsp.servers).mockResolvedValue([
      {
        key: 'lsp-go/gopls',
        extId: 'lsp-go',
        extName: 'Go',
        serverId: 'gopls',
        name: 'gopls',
        languages: ['go'],
        kind: 'program',
        command: 'gopls',
        enabled: true,
        status: 'running',
        folders: 1,
      },
    ])
    await show(
      [
        ext('lsp-go', 'Go', {
          languageServers: [{ id: 'gopls', name: 'gopls', languages: ['go'], command: 'gopls' }],
        }),
        ext('manual', 'Manual'),
      ],
      stateWith([]),
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Settings of Go' }))
    const go = screen.getByRole('region', { name: 'Settings of Go' })
    const server = await within(go).findByRole('group', { name: 'gopls' })
    expect(within(server).getByRole('switch', { name: 'Enable gopls' })).toBeChecked()
    expect(within(server).getByRole('button', { name: 'Restart gopls' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Settings of Manual' }))
    const manual = screen.getByRole('region', { name: 'Settings of Manual' })
    expect(within(manual).queryByText('Language servers')).toBeNull()
  })

  it('offers Update to the offered version on the row and installs it', async () => {
    await show(
      [ext('weather', 'Weather')],
      stateWith([{ ...WEATHER, version: '1.5.0', state: 'update', installedVersion: '1.0.0' }]),
    )
    vi.mocked(window.ostia.marketplace.install).mockResolvedValue({
      ok: true,
      state: stateWith([WEATHER]),
    })

    const row = screen.getByRole('listitem', { name: 'Weather' })
    await userEvent.click(within(row).getByRole('button', { name: 'Update to 1.5.0' }))

    expect(window.ostia.marketplace.install).toHaveBeenCalledWith('abc123', 'weather')
  })

  it('offers Approve… on a row that waits for approval and no Update when none is offered', async () => {
    const review = vi.fn()
    useExtensionsStore.setState({ review })
    await show(
      [ext('weather', 'Weather', { status: 'pending-approval', enabled: false })],
      stateWith([WEATHER]),
    )

    const row = screen.getByRole('listitem', { name: 'Weather' })
    expect(within(row).queryByRole('button', { name: /^Update to/ })).toBeNull()
    await userEvent.click(within(row).getByRole('button', { name: 'Approve…' }))

    expect(review).toHaveBeenCalledWith('weather')
  })

  it('shows a problem chip only for an extension that crashed', async () => {
    await show(
      [ext('weather', 'Weather', { status: 'crashed' }), ext('manual', 'Manual')],
      stateWith([WEATHER]),
    )

    expect(
      within(screen.getByRole('listitem', { name: 'Weather' })).getByText('Problem'),
    ).toBeVisible()
    expect(
      within(screen.getByRole('listitem', { name: 'Manual' })).queryByText('Problem'),
    ).toBeNull()
  })
})

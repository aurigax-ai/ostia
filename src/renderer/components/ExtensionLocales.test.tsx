import type { ExtensionInfo } from '@shared/extensions'
import type { MarketplaceState } from '@shared/marketplace'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncExtensionCommands, wireExtensionBridge } from '../commands/extensionBridge'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useMarketplaceStore } from '../stores/marketplaceStore'
import { useUIStore } from '../stores/uiStore'
import { type Workspace, useWorkspacesStore } from '../stores/workspacesStore'
import { CommandPalette } from './CommandPalette'
import { ExtensionApprovalDialog } from './ExtensionApprovalDialog'
import { MarketplaceSection } from './MarketplaceSection'
import { PanelToggles } from './PanelToggles'
import { ExtensionsSection } from './SettingsPanel'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

function greeter(overrides: Partial<ExtensionInfo>): ExtensionInfo {
  return {
    id: 'greeter',
    version: '1.0.0',
    name: 'Greeter',
    description: 'Says hello',
    category: 'other',
    builtin: true,
    enabled: true,
    status: 'idle',
    requested: [],
    granted: [],
    languageServers: [],
    agentSkills: [],
    agentHooks: [],
    unapproved: [],
    commands: [
      {
        id: 'greet',
        title: 'Greet Someone',
        category: 'Greeter',
        palette: true,
        stdin: false,
        capabilities: [],
      },
    ],
    panel: { title: 'Greeter Panel', icon: 'puzzle' },
    paneChips: [],
    workspaceChips: [],
    settings: [{ key: 'word', type: 'string', default: 'hi', title: 'Word', description: 'Used' }],
    settingValues: { word: 'hi' },
    assist: [],
    secrets: [],
    secretsSet: [],
    settingsPage: null,
    iconThemes: [],
    keymaps: [],
    languages: [],
    ...overrides,
  }
}

const ENGLISH = greeter({})

const TRADITIONAL_CHINESE = greeter({
  name: '問候者',
  description: '向你打招呼',
  commands: [{ ...ENGLISH.commands[0], title: '向某人打招呼', category: '問候者' }],
  panel: { title: '問候面板', icon: 'puzzle' },
  settings: [{ ...ENGLISH.settings[0], title: '字詞', description: '打招呼時使用' }],
})

const WORKSPACE: Workspace = {
  id: 'w1',
  name: 'one',
  kind: 'terminal',
  workDir: '/tmp/one',
  state: 'idle',
}

describe('extension wording follows the list main resolved for the language', () => {
  let extInit: ReturnType<typeof useExtensionsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let marketplaceInit: ReturnType<typeof useMarketplaceStore.getState>
  let announce: (list: ExtensionInfo[]) => void = () => {}

  beforeAll(() => {
    extInit = useExtensionsStore.getState()
    uiInit = useUIStore.getState()
    marketplaceInit = useMarketplaceStore.getState()
  })

  beforeEach(async () => {
    vi.mocked(window.ostia.extensions.list).mockResolvedValue([ENGLISH])
    vi.mocked(window.ostia.extensions.onChanged).mockImplementation((cb) => {
      announce = cb
      return () => {}
    })
    wireExtensionBridge()
    await waitFor(() => expect(useExtensionsStore.getState().list).toEqual([ENGLISH]))
  })

  afterEach(() => {
    cleanup()
    syncExtensionCommands([])
    useExtensionsStore.setState(extInit, true)
    useUIStore.setState(uiInit, true)
    useMarketplaceStore.setState(marketplaceInit, true)
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null })
    useLayoutStore.setState({ byWorkspace: {} })
  })

  it('Settings → Extensions shows the English name, then the translated one, then English again', async () => {
    render(<ExtensionsSection />)
    const section = screen.getByRole('region', { name: 'Extensions' })
    expect(within(section).getByText('Greeter')).toBeInTheDocument()
    expect(within(section).getByText('Says hello')).toBeInTheDocument()

    await act(async () => announce([TRADITIONAL_CHINESE]))
    expect(within(section).getByText('問候者')).toBeInTheDocument()
    expect(within(section).getByText('向你打招呼')).toBeInTheDocument()
    expect(within(section).queryByText('Greeter')).toBeNull()

    await act(async () => announce([ENGLISH]))
    expect(within(section).getByText('Greeter')).toBeInTheDocument()
    expect(within(section).queryByText('問候者')).toBeNull()
  })

  it('the palette retitles the command while it is open and still runs the same command', async () => {
    useUIStore.setState({ paletteOpen: true })
    render(<CommandPalette />)
    expect(await screen.findByRole('option', { name: /Greet Someone/ })).toBeInTheDocument()

    await act(async () => announce([TRADITIONAL_CHINESE]))
    const option = await screen.findByRole('option', { name: /向某人打招呼/ })
    expect(screen.queryByRole('option', { name: /Greet Someone/ })).toBeNull()
    expect(screen.getByText('問候者')).toBeInTheDocument()

    await userEvent.click(option)
    await waitFor(() =>
      expect(window.ostia.extensions.invoke).toHaveBeenCalledWith(
        'greeter',
        'greet',
        { workspaceId: null, paneId: null },
        undefined,
      ),
    )

    await act(async () => {
      announce([ENGLISH])
      useUIStore.setState({ paletteOpen: true })
    })
    expect(await screen.findByRole('option', { name: /Greet Someone/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /向某人打招呼/ })).toBeNull()
  })

  it('the panel toggle is labelled in the language', async () => {
    useWorkspacesStore.setState({ workspaces: [WORKSPACE], activeWorkspaceId: WORKSPACE.id })
    render(<PanelToggles />)
    expect(screen.getByRole('button', { name: 'Greeter Panel' })).toBeInTheDocument()
    await act(async () => announce([TRADITIONAL_CHINESE]))
    expect(screen.getByRole('button', { name: '問候面板' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Greeter Panel' })).toBeNull()
  })

  it('the approval dialog names a waiting extension in the language', async () => {
    const waiting = (info: ExtensionInfo): ExtensionInfo => ({
      ...info,
      builtin: false,
      enabled: false,
      status: 'pending-approval',
      requested: ['notify'],
      unapproved: ['notify'],
    })
    await act(async () => announce([waiting(ENGLISH)]))
    render(<ExtensionApprovalDialog />)
    expect(screen.getByText('Allow the extension “Greeter”?')).toBeInTheDocument()
    await act(async () => announce([waiting(TRADITIONAL_CHINESE)]))
    expect(screen.getByText('Allow the extension “問候者”?')).toBeInTheDocument()
    expect(screen.getByText('向你打招呼')).toBeInTheDocument()
  })

  it('the marketplace list is read again when main announces a new list', async () => {
    const listing = (name: string): MarketplaceState => ({
      installed: [],
      marketplaces: [
        {
          id: 'm1',
          url: 'https://github.com/acme/ext.git',
          name: 'Acme',
          description: '',
          problems: [],
          unlisted: false,
          extensions: [
            {
              id: 'weather',
              name,
              version: '1.0.0',
              description: '',
              category: 'tools',
              capabilities: [],
              runsProcess: true,
              state: 'available',
            },
          ],
        },
      ],
    })
    vi.mocked(window.ostia.marketplace.list).mockResolvedValue(listing('Weather'))
    render(<MarketplaceSection />)
    expect(await screen.findByRole('listitem', { name: 'Weather' })).toBeInTheDocument()

    vi.mocked(window.ostia.marketplace.list).mockResolvedValue(listing('天氣'))
    await act(async () => announce([TRADITIONAL_CHINESE]))
    expect(await screen.findByRole('listitem', { name: '天氣' })).toBeInTheDocument()
    expect(screen.queryByRole('listitem', { name: 'Weather' })).toBeNull()
  })
})

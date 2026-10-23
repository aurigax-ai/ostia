import '@testing-library/jest-dom/vitest'
import type {
  ExtensionInfo,
  ExtensionResult,
  WorkspaceChip,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { extensionCommandId } from '@/commands/extensionBridge'
import { commands } from '@/commands/registry'
import { CommandPalette } from '@/components/palette/CommandPalette'
import { allPanes, createPane } from '@/lib/layout/tree'
import { COMMANDS_PREFIX } from '@/lib/palette/paletteModes'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useSidePanelStore } from '@/stores/app/sidePanelStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { TopBar } from './TopBar'

const git: ExtensionInfo = {
  id: 'vcs',
  name: 'Git',
  version: '1.0.0',
  description: '',
  builtin: true,
  enabled: true,
  status: 'running',
  requested: [],
  granted: [],
  unapproved: [],
  commands: [],
  panel: { title: 'Changes', icon: 'git-branch' },
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
}

describe('TopBar', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let extInit: ReturnType<typeof useExtensionsStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let sideInit: ReturnType<typeof useSidePanelStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    uiInit = useUIStore.getState()
    extInit = useExtensionsStore.getState()
    settingsInit = useSettingsStore.getState()
    sideInit = useSidePanelStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useUIStore.setState(uiInit, true)
    useExtensionsStore.setState(extInit, true)
    useSettingsStore.setState(settingsInit, true)
    useSidePanelStore.setState(sideInit, true)
    vi.restoreAllMocks()
  })

  function seedWorkspace(): void {
    useWorkspacesStore.setState({
      workspaces: [{ id: 's1', name: 'home', kind: 'terminal', workDir: '/home', state: 'idle' }],
      activeWorkspaceId: 's1',
    })
    const pane = createPane('terminal')
    useLayoutStore.setState({
      byWorkspace: { s1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })
  }

  it('adds a workspace and leaves Settings from the New workspace button', async () => {
    const addWorkspace = vi
      .spyOn(useWorkspacesStore.getState(), 'addWorkspace')
      .mockImplementation(() => {})
    const showWorkspaces = vi.spyOn(useUIStore.getState(), 'showWorkspaces')
    render(<TopBar />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'New workspace' }))
    expect(addWorkspace).toHaveBeenCalledTimes(1)
    expect(showWorkspaces).toHaveBeenCalled()
  })

  it('starts a scratch workspace, or a sandboxed one, from the New workspace menu', async () => {
    const user = userEvent.setup()
    render(<TopBar />)

    await user.click(screen.getByRole('button', { name: 'More ways to start a workspace' }))
    await user.click(await screen.findByRole('menuitem', { name: 'New scratch workspace' }))
    await waitFor(() => expect(useWorkspacesStore.getState().workspaces).toHaveLength(1))
    const [scratch] = useWorkspacesStore.getState().workspaces
    expect(scratch).toMatchObject({
      kind: 'scratch',
      customName: expect.stringMatching(/^[a-z]+-[a-z]+$/),
      workDir: '/tmp/ostia-scratch-1000/1-aaaaaaaaaaaa',
    })
    expect(window.ostia.sandbox.setEnabled).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'More ways to start a workspace' }))
    await user.click(
      await screen.findByRole('menuitem', { name: 'New sandboxed scratch workspace' }),
    )
    await waitFor(() => expect(useWorkspacesStore.getState().workspaces).toHaveLength(2))
    const second = useWorkspacesStore.getState().workspaces.find((w) => w.id !== scratch.id)
    expect(second?.customName).toMatch(/^[a-z]+-[a-z]+$/)
    expect(second?.customName).not.toBe(scratch.customName)
    expect(window.ostia.sandbox.setEnabled).toHaveBeenCalledWith(second?.id, true)
  })

  describe('SSH hosts in the New workspace menu', () => {
    const ssh: ExtensionInfo = {
      ...git,
      id: 'ssh',
      name: 'SSH',
      panel: null,
      commands: [
        {
          id: 'connect',
          title: 'SSH: Connect to Host…',
          argument: 'Host',
          palette: true,
          stdin: false,
          capabilities: [],
        },
      ],
    }

    function stubSsh(hosts: string[], truncated = false): ReturnType<typeof vi.fn> {
      const invoke = vi.fn(
        async (_ext: string, command: string): Promise<ExtensionResult> =>
          command === 'ls'
            ? { ok: true, data: { hosts: hosts.map((alias) => ({ alias })), truncated } }
            : { ok: true, data: { paneId: 'p-ssh' } },
      )
      window.ostia.extensions.invoke = invoke
      return invoke
    }

    async function openHosts(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await user.click(screen.getByRole('button', { name: 'More ways to start a workspace' }))
      await user.click(await screen.findByRole('menuitem', { name: 'Connect to SSH host' }))
    }

    it('lists the ssh config hosts and opens a workspace named after the picked one', async () => {
      useExtensionsStore.setState({ list: [ssh] })
      const invoke = stubSsh(['db', 'web'])
      const user = userEvent.setup()
      render(<TopBar />)

      await openHosts(user)
      expect(await screen.findByRole('menuitem', { name: 'db' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('menuitem', { name: 'web' }))

      await waitFor(() => expect(useWorkspacesStore.getState().workspaces).toHaveLength(1))
      const [added] = useWorkspacesStore.getState().workspaces
      expect(added.customName).toBe('web')
      expect(invoke).toHaveBeenCalledWith('ssh', 'ls', { workspaceId: null, paneId: null })
      expect(invoke).toHaveBeenCalledWith(
        'ssh',
        'connect',
        { workspaceId: added.id, paneId: null },
        'web',
      )
    })

    it('says so when the ssh config has no hosts, and points to the palette when cut short', async () => {
      useExtensionsStore.setState({ list: [ssh] })
      stubSsh([])
      const user = userEvent.setup()
      const { unmount } = render(<TopBar />)
      await openHosts(user)
      expect(
        await screen.findByRole('menuitem', { name: 'No hosts in ~/.ssh/config' }),
      ).toHaveAttribute('aria-disabled', 'true')
      unmount()

      stubSsh(['a'], true)
      render(<TopBar />)
      await openHosts(user)
      expect(
        await screen.findByRole('menuitem', {
          name: 'More hosts: SSH: Connect to Host… in the command palette',
        }),
      ).toBeInTheDocument()
    })

    it('leaves SSH out of the menu when the SSH extension is off', async () => {
      useExtensionsStore.setState({ list: [{ ...ssh, enabled: false }] })
      const user = userEvent.setup()
      render(<TopBar />)
      await user.click(screen.getByRole('button', { name: 'More ways to start a workspace' }))
      await screen.findByRole('menuitem', { name: 'New scratch workspace' })
      expect(screen.queryByRole('menuitem', { name: 'Connect to SSH host' })).toBeNull()
    })
  })

  it('the UI, settings lists, keycaps, chat code and the git panel use the chosen UI and code fonts', () => {
    const { container } = render(<TopBar />)
    const keycap = container.querySelector('header.topbar kbd')
    expect(keycap).toHaveClass('font-sans')
    expect(keycap).not.toHaveClass('font-mono')
  })

  it('puts New workspace first and Settings in the right zone before the bell', () => {
    const { container } = render(<TopBar />)
    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons[0]).toHaveAccessibleName('New workspace')
    const right = container.querySelector('.topbar-right')
    const rightNames = Array.from(right?.querySelectorAll('button') ?? []).map((b) =>
      b.getAttribute('aria-label'),
    )
    expect(rightNames[0]).toBe('Settings')
    expect(rightNames.length).toBeGreaterThan(1)
  })

  it('opens Settings and toggles the Files panel', async () => {
    render(<TopBar />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(useUIStore.getState().settingsActive).toBe(true)

    const files = screen.getByRole('button', { name: 'Files' })
    expect(files).toHaveAttribute('aria-pressed', 'false')
    await user.click(files)
    expect(useUIStore.getState().filesOpen).toBe(true)
    expect(files).toHaveAttribute('aria-pressed', 'true')
    await user.click(files)
    expect(useUIStore.getState().filesOpen).toBe(false)
    expect(files).toHaveAttribute('aria-pressed', 'false')
  })

  it('the top-bar search shows the palette chord and opens the palette in command mode', async () => {
    render(
      <>
        <TopBar />
        <CommandPalette />
      </>,
    )
    const button = screen.getByRole('button', { name: /Search or run a command/ })
    expect(within(button).getByText('Ctrl+Shift+P')).toBeInTheDocument()
    expect(within(button).queryByText(/Shift\+Shift/)).toBeNull()
    await userEvent.click(button)

    const palette = await screen.findByRole('dialog', { name: 'Command palette' })
    expect(useUIStore.getState().paletteMode).toBe('search')
    expect(useUIStore.getState().paletteSeed).toBe(COMMANDS_PREFIX)
    await waitFor(() => expect(within(palette).getByRole('combobox')).toHaveFocus())
  })

  it('the top-bar search label follows the user’s palette.toggle binding', () => {
    useSettingsStore.setState({
      keybindings: { ...useSettingsStore.getState().keybindings, 'palette.toggle': 'Ctrl+Alt+K' },
    })
    render(<TopBar />)
    const button = screen.getByRole('button', { name: /Search or run a command/ })
    expect(within(button).getByText('Ctrl+Alt+K')).toBeInTheDocument()
  })

  it('puts the extension panel toggles right after Files and the accounts menu on the left, and the Git chip stays on the right', () => {
    seedWorkspace()
    const activity: ExtensionInfo = {
      ...git,
      id: 'activity',
      name: 'Activity',
      panel: { title: 'Activity', icon: 'chat' },
    }
    useExtensionsStore.setState({
      list: [
        { ...git, panel: null, workspaceChips: [{ id: 'branch', title: 'Git branch' }] },
        activity,
      ],
      workspaceChips: [
        { extId: 'vcs', id: 'branch', workspaceId: 's1', text: 'main', tone: 'neutral' },
      ],
    })
    const { container } = render(<TopBar />)
    const names = (selector: string) =>
      Array.from(container.querySelector(selector)?.querySelectorAll('button') ?? []).map((b) =>
        b.getAttribute('aria-label'),
      )
    expect(names('.topbar-left').slice(-3)).toEqual(['Files', 'Claude accounts', 'Activity'])
    expect(names('.topbar-right')).not.toContain('Activity')
    expect(container.querySelector('.topbar-right')).toContainElement(
      screen.getByRole('list', { name: 'Workspace status' }),
    )
  })

  it('toggles an extension panel in the right side panel', async () => {
    seedWorkspace()
    useExtensionsStore.setState({ list: [git] })
    render(<TopBar />)
    const user = userEvent.setup()
    const changes = screen.getByRole('button', { name: 'Changes' })

    await user.click(changes)
    expect(useSidePanelStore.getState().right).toBe('vcs')
    expect(changes).toHaveAttribute('aria-pressed', 'true')
    const root = useLayoutStore.getState().byWorkspace.s1?.root
    expect(root ? allPanes(root).map((p) => p.kind) : []).not.toContain('extension')

    await user.click(changes)
    expect(useSidePanelStore.getState().right).toBeNull()
    expect(changes).toHaveAttribute('aria-pressed', 'false')
  })

  it('renders one button per top-bar control, with no nested buttons and no repeated names', () => {
    seedWorkspace()
    const assistant: ExtensionInfo = {
      ...git,
      id: 'assistant',
      name: 'Assistant',
      builtin: true,
      panel: { title: 'Assistant', icon: 'chat' },
      assist: ['chat'],
    }
    useExtensionsStore.setState({ list: [git, assistant] })
    const { container } = render(<TopBar />)
    expect(container.querySelectorAll('button button')).toHaveLength(0)
    const names = Array.from(container.querySelectorAll('button')).map((b) =>
      b.getAttribute('aria-label'),
    )
    expect(names.filter((n) => n?.startsWith('Assistant'))).toHaveLength(1)
    const labelled = names.filter((n): n is string => n !== null)
    expect(new Set(labelled).size).toBe(labelled.length)
    expect(screen.getByRole('button', { name: /^Assistant/ })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    )
  })

  it("shows the active workspace's chips in the top bar and swaps them with the workspace", async () => {
    useWorkspacesStore.setState({
      workspaces: [
        { id: 's1', name: 'app', kind: 'terminal', workDir: '/app', state: 'idle' },
        { id: 's2', name: 'api', kind: 'terminal', workDir: '/api', state: 'idle' },
      ],
      activeWorkspaceId: 's1',
    })
    const chip = (workspaceId: string, id: string, text: string): WorkspaceChip => ({
      extId: 'vcs',
      id,
      workspaceId,
      text,
      tone: 'neutral',
      ...(id === 'branch' ? { command: 'show' } : {}),
    })
    useExtensionsStore.setState({
      list: [
        {
          ...git,
          workspaceChips: [
            { id: 'branch', title: 'Git branch' },
            { id: 'diff-stats', title: 'Git diff stats' },
          ],
        },
      ],
      workspaceChips: [
        chip('s1', 'branch', 'main'),
        chip('s1', 'diff-stats', '2 · +51 -3'),
        chip('s2', 'branch', 'dev'),
      ],
    })
    const run = vi.fn()
    const showId = extensionCommandId('vcs', 'show')
    commands.register({ id: showId, title: 'Show', run })
    try {
      const { container } = render(<TopBar />)
      const chips = () => screen.getByRole('list', { name: 'Workspace status' })
      expect(container.querySelector('.topbar-right')).toContainElement(chips())
      expect(
        within(chips())
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual(['main', '2 · +51 -3'])

      await userEvent.setup().click(within(chips()).getByRole('button', { name: /main/ }))
      expect(run).toHaveBeenCalledTimes(1)

      act(() => useWorkspacesStore.setState({ activeWorkspaceId: 's2' }))
      expect(
        within(chips())
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual(['dev'])

      act(() => useWorkspacesStore.setState({ activeWorkspaceId: null }))
      expect(screen.queryByRole('list', { name: 'Workspace status' })).toBeNull()
    } finally {
      commands.unregister(showId)
    }
  })

  it('shows no panel toggle for a disabled extension', () => {
    seedWorkspace()
    useExtensionsStore.setState({ list: [{ ...git, enabled: false }] })
    render(<TopBar />)
    expect(screen.queryByRole('button', { name: 'Changes' })).toBeNull()
  })
})

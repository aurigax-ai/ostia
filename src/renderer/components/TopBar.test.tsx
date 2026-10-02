import '@testing-library/jest-dom/vitest'
import type { ExtensionInfo, WorkspaceChip } from '@shared/extensions'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { extensionCommandId } from '../commands/extensionBridge'
import { commands } from '../commands/registry'
import { createPane, findExtensionPane } from '../layout/tree'
import { useApprovalsStore } from '../stores/approvalsStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useQuestionsStore } from '../stores/questionsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { TopBar } from './TopBar'

const git: ExtensionInfo = {
  id: 'git',
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
  settingsPage: null,
  category: 'other',
  languages: [],
  languageServers: [],
  iconThemes: [],
}

describe('TopBar', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let extInit: ReturnType<typeof useExtensionsStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    uiInit = useUIStore.getState()
    extInit = useExtensionsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useUIStore.setState(uiInit, true)
    useExtensionsStore.setState(extInit, true)
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
      workDir: '/tmp/pine-scratch-1000/1-aaaaaaaaaaaa',
    })
    expect(window.pine.sandbox.setEnabled).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'More ways to start a workspace' }))
    await user.click(
      await screen.findByRole('menuitem', { name: 'New sandboxed scratch workspace' }),
    )
    await waitFor(() => expect(useWorkspacesStore.getState().workspaces).toHaveLength(2))
    const second = useWorkspacesStore.getState().workspaces.find((w) => w.id !== scratch.id)
    expect(second?.customName).toMatch(/^[a-z]+-[a-z]+$/)
    expect(second?.customName).not.toBe(scratch.customName)
    expect(window.pine.sandbox.setEnabled).toHaveBeenCalledWith(second?.id, true)
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
  })

  it('puts the dashboard button after Files and before the extension panel toggles', () => {
    seedWorkspace()
    useExtensionsStore.setState({ list: [git] })
    const { container } = render(<TopBar />)
    const left = container.querySelector('.topbar-left')
    const names = Array.from(left?.querySelectorAll('button') ?? []).map((b) =>
      b.getAttribute('aria-label'),
    )
    expect(names.slice(-3)).toEqual(['Files', 'Dashboard', 'Changes'])
  })

  it('opens and closes the dashboard from its button, pressed while open', async () => {
    render(<TopBar />)
    const user = userEvent.setup()
    const button = screen.getByRole('button', { name: 'Dashboard' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await user.click(button)
    expect(useUIStore.getState().dashboardActive).toBe(true)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    await user.click(button)
    expect(useUIStore.getState().dashboardActive).toBe(false)
  })

  it('counts open questions and permission requests on the dashboard button, only when any wait', () => {
    const { container } = render(<TopBar />)
    const left = () => container.querySelector('.topbar-left') as HTMLElement
    expect(left().querySelector('.count-badge')).toBeNull()

    act(() => {
      useQuestionsStore.setState({
        pending: [
          {
            id: 'q1',
            paneId: 'p1',
            question: 'Ship?',
            context: '',
            choices: [],
            mode: 'text',
            at: 1,
          },
        ],
      })
      useApprovalsStore.setState({
        pending: [
          {
            id: 'a1',
            paneId: 'p1',
            workspaceId: 's1',
            caps: ['shell'],
            action: 'Resume Agent',
            detail: '',
            at: 2,
          },
        ],
      })
    })
    expect(left().querySelector('.count-badge')).toHaveTextContent('2')
    expect(screen.getByRole('button', { name: 'Dashboard, 2 waiting for you' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument()

    act(() => {
      useQuestionsStore.setState({ pending: [] })
      useApprovalsStore.setState({ pending: [] })
    })
    expect(left().querySelector('.count-badge')).toBeNull()
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeInTheDocument()
  })

  it('toggles an extension panel in the active workspace', async () => {
    seedWorkspace()
    useExtensionsStore.setState({ list: [git] })
    render(<TopBar />)
    const user = userEvent.setup()
    const changes = screen.getByRole('button', { name: 'Changes' })

    await user.click(changes)
    const opened = findExtensionPane(useLayoutStore.getState().byWorkspace.s1.root, 'git')
    expect(opened).not.toBeNull()
    expect(changes).toHaveAttribute('aria-pressed', 'true')

    await user.click(changes)
    const root = useLayoutStore.getState().byWorkspace.s1?.root
    expect(root ? findExtensionPane(root, 'git') : null).toBeNull()
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
      extId: 'git',
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
    const showId = extensionCommandId('git', 'show')
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

      act(() => useUIStore.getState().openDashboard())
      expect(screen.queryByRole('list', { name: 'Workspace status' })).toBeNull()
      act(() => useUIStore.getState().showWorkspaces())
      expect(chips()).toHaveTextContent('dev')

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

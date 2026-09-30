import '@testing-library/jest-dom/vitest'
import type { ExtensionInfo } from '@shared/extensions'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPane, findExtensionPane } from '../layout/tree'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
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
  settings: [],
  settingValues: {},
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
    const leaveSettings = vi.spyOn(useUIStore.getState(), 'leaveSettings')
    render(<TopBar />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'New workspace' }))
    expect(addWorkspace).toHaveBeenCalledTimes(1)
    expect(leaveSettings).toHaveBeenCalled()
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

  it('shows no panel toggle for a disabled extension', () => {
    seedWorkspace()
    useExtensionsStore.setState({ list: [{ ...git, enabled: false }] })
    render(<TopBar />)
    expect(screen.queryByRole('button', { name: 'Changes' })).toBeNull()
  })
})

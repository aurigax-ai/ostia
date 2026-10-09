import '@testing-library/jest-dom/vitest'
import { registerGitCommands } from '@/commands/gitCommands'
import { commands } from '@/commands/registry'
import { WorkspaceChips } from '@/components/extensions/ExtensionChips'
import { ExtensionPanelView } from '@/components/extensions/ExtensionPanelView'
import { GitSection, PortsSection } from '@/components/settings/BoardSettings'
import { PanelToggles } from '@/components/shell/PanelToggles'
import { createPane, firstPaneOfKind, setPaneEditor } from '@/layout/tree'
import { resetCoreWatch } from '@/lib/workspaces/coreWatch'
import { useExtensionsStore } from '@/stores/extensionsStore'
import { useGitViewStore } from '@/stores/gitViewStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import type { CoreItems } from '@shared/git'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const settle = (): Promise<void> => new Promise((r) => queueMicrotask(r))

const GIT_ITEMS: CoreItems = {
  sidebar: [
    {
      extId: 'git',
      workspaceId: 's1',
      key: 'branch',
      text: 'main',
      icon: 'git-branch',
      tone: 'neutral',
      kind: 'location',
    },
  ],
  paneChips: [],
  workspaceChips: [
    {
      extId: 'git',
      workspaceId: 's1',
      id: 'branch',
      text: 'main',
      tone: 'neutral',
      command: 'git.show',
    },
    { extId: 'git', workspaceId: 's1', id: 'diff-stats', text: '1 • +2 -1', tone: 'neutral' },
  ],
}

const PORTS_ITEMS: CoreItems = {
  sidebar: [],
  paneChips: [],
  workspaceChips: [
    {
      extId: 'ports',
      workspaceId: 's1',
      id: 'ports',
      icon: 'plugs',
      text: '1',
      tone: 'neutral',
      items: [{ text: ':3000', url: 'http://localhost:3000/' }],
    },
  ],
}

describe('core git and ports in the window', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let extInit: ReturnType<typeof useExtensionsStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let gitViewInit: ReturnType<typeof useGitViewStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    uiInit = useUIStore.getState()
    extInit = useExtensionsStore.getState()
    settingsInit = useSettingsStore.getState()
    gitViewInit = useGitViewStore.getState()
    registerGitCommands()
    commands.setContextProvider(() => {
      const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
      const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
      return { activeWorkspaceId: workspaceId, activePaneId: layout?.activePaneId ?? null }
    })
  })

  afterAll(() => {
    commands.setContextProvider(() => ({ activeWorkspaceId: null, activePaneId: null }))
    for (const id of ['git.show', 'git.showGraph', 'git.blameFile']) commands.unregister(id)
  })

  beforeEach(() => {
    useWorkspacesStore.setState({
      workspaces: [{ id: 's1', name: 'home', kind: 'terminal', workDir: '/home', state: 'idle' }],
      activeWorkspaceId: 's1',
    })
    const pane = createPane('terminal')
    useLayoutStore.setState({
      byWorkspace: { s1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })
  })

  afterEach(() => {
    cleanup()
    resetCoreWatch()
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useUIStore.setState(uiInit, true)
    useExtensionsStore.setState(extInit, true)
    useSettingsStore.setState(settingsInit, true)
    useGitViewStore.setState(gitViewInit, true)
    vi.mocked(window.ostia.git.watch).mockClear()
    vi.mocked(window.ostia.ports.watch).mockClear()
  })

  const gitPane = () => firstPaneOfKind(useLayoutStore.getState().byWorkspace.s1.root, 'git')

  it('shows what main sent before what extensions contributed, and drops it when main clears it', () => {
    const store = useExtensionsStore.getState()
    store.setWorkspaceChips([
      { extId: 'env', workspaceId: 's1', id: 'venv', text: '.venv', tone: 'neutral' },
    ])
    store.setGitItems(GIT_ITEMS)
    store.setPortsItems(PORTS_ITEMS)
    expect(useExtensionsStore.getState().workspaceChips.map((c) => `${c.extId}.${c.id}`)).toEqual([
      'git.branch',
      'git.diff-stats',
      'ports.ports',
      'env.venv',
    ])
    expect(useExtensionsStore.getState().sidebar.map((i) => i.text)).toEqual(['main'])
    store.setGitItems({ sidebar: [], paneChips: [], workspaceChips: [] })
    expect(useExtensionsStore.getState().workspaceChips.map((c) => c.extId)).toEqual([
      'ports',
      'env',
    ])
    expect(useExtensionsStore.getState().sidebar).toEqual([])
  })

  it('asks main to watch a workspace only while its chips are on screen', async () => {
    const view = render(<WorkspaceChips workspaceId="s1" />)
    await settle()
    expect(window.ostia.git.watch).toHaveBeenLastCalledWith(['s1'])
    expect(window.ostia.ports.watch).toHaveBeenLastCalledWith(['s1'])
    view.unmount()
    await settle()
    expect(window.ostia.git.watch).toHaveBeenLastCalledWith([])
    expect(window.ostia.ports.watch).toHaveBeenLastCalledWith([])
  })

  it('titles the core chips, and the branch chip opens the Git panel on Changes', async () => {
    render(<WorkspaceChips workspaceId="s1" />)
    act(() => {
      useExtensionsStore.getState().setGitItems(GIT_ITEMS)
      useExtensionsStore.getState().setPortsItems(PORTS_ITEMS)
    })
    expect(screen.getByText('1 • +2 -1')).toBeVisible()
    await userEvent.setup().click(screen.getByRole('button', { name: /Git branch: main/ }))
    await waitFor(() => expect(gitPane()).not.toBeNull())
    const pane = gitPane()
    expect(pane?.title).toBe('Git')
    expect(useGitViewStore.getState().nav[pane?.id ?? '']).toMatchObject({ page: 'changes' })
  })

  it('toggles the Git panel from the top bar, and hides the button when Git is off', async () => {
    const user = userEvent.setup()
    render(<PanelToggles />)
    const button = screen.getByRole('button', { name: 'Git' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await user.click(button)
    expect(gitPane()).not.toBeNull()
    expect(button).toHaveAttribute('aria-pressed', 'true')
    await user.click(button)
    expect(gitPane()).toBeNull()
    act(() => useSettingsStore.getState().setGit({ enabled: false }))
    expect(screen.queryByRole('button', { name: 'Git' })).toBeNull()
  })

  it('opens the graph, and blame only for a focused file', async () => {
    await commands.exec('git.showGraph')
    const pane = gitPane()
    expect(useGitViewStore.getState().nav[pane?.id ?? '']).toMatchObject({ page: 'graph' })

    const terminal = useLayoutStore.getState().byWorkspace.s1
    const first = firstPaneOfKind(terminal.root, 'terminal')
    useLayoutStore.setState({
      byWorkspace: { s1: { ...terminal, activePaneId: first?.id ?? '' } },
    })
    expect(await commands.exec('git.blameFile')).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('not a file') },
    })

    const withFile = useLayoutStore.getState().byWorkspace.s1
    useLayoutStore.setState({
      byWorkspace: {
        s1: {
          ...withFile,
          root: setPaneEditor(withFile.root, first?.id ?? '', 'a.txt', '/home/a.txt'),
        },
      },
    })
    await commands.exec('git.blameFile')
    expect(useGitViewStore.getState().nav[gitPane()?.id ?? '']).toMatchObject({
      page: 'blame',
      file: '/home/a.txt',
    })
  })

  it('tells the human a saved pane of the old Git extension is gone, without loading anything', () => {
    render(<ExtensionPanelView extId="git" workspaceId="s1" paneId="p9" />)
    expect(screen.getByText(/Git is built in now/)).toBeVisible()
    expect(window.ostia.extensions.panel).not.toHaveBeenCalled()
  })

  it('writes the Git and Ports settings from their pages, within their bounds', async () => {
    const user = userEvent.setup()
    render(
      <>
        <GitSection />
        <PortsSection />
      </>,
    )
    await user.click(screen.getByRole('switch', { name: 'Diff stats in the top bar' }))
    expect(useSettingsStore.getState().git.showDiffStats).toBe(false)
    const poll = screen.getByRole('spinbutton', { name: 'Refresh interval' })
    await user.clear(poll)
    await user.type(poll, '1{Enter}')
    expect(useSettingsStore.getState().git.pollSeconds).toBe(2)
    await user.click(screen.getByRole('switch', { name: 'Show ports and ssh logins' }))
    expect(useSettingsStore.getState().ports.enabled).toBe(false)
    const interval = screen.getByRole('spinbutton', { name: 'Scan interval' })
    await user.clear(interval)
    await user.type(interval, '600{Enter}')
    expect(useSettingsStore.getState().ports.intervalSeconds).toBe(60)
  })
})

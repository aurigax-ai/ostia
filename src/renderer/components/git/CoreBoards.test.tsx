import '@testing-library/jest-dom/vitest'
import type { CoreItems } from '@shared/boards/git'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerGitCommands } from '@/commands/gitCommands'
import { commands } from '@/commands/registry'
import { PanelToggles } from '@/components/app/PanelToggles'
import { TopBar } from '@/components/app/TopBar'
import { PaneChips, WorkspaceChips } from '@/components/extensions/ExtensionChips'
import { GitSection, PortsSection } from '@/components/settings/BoardSettings'
import { firstPaneOfKind, setPaneEditor } from '@/lib/layout/paneFields'
import { createPane } from '@/lib/layout/tree'
import { resetCoreWatch } from '@/lib/workspaces/coreWatch'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useSidePanelStore } from '@/stores/app/sidePanelStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useGitViewStore } from '@/stores/files/gitViewStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { renderSettled } from '../../../../test/render'

const settle = (): Promise<void> => new Promise((r) => queueMicrotask(r))

function userOnFakeClock(): ReturnType<typeof userEvent.setup> {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  })
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) })
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
}

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
      text: 'main · +2 −1',
      tone: 'neutral',
      command: 'git.show',
    },
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
  let sideInit: ReturnType<typeof useSidePanelStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    uiInit = useUIStore.getState()
    extInit = useExtensionsStore.getState()
    settingsInit = useSettingsStore.getState()
    gitViewInit = useGitViewStore.getState()
    sideInit = useSidePanelStore.getState()
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
    vi.useRealTimers()
    resetCoreWatch()
    useWorkspacesStore.setState(workspacesInit, true)
    useSidePanelStore.setState(sideInit, true)
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

  it('titles the core chips, and the branch chip shows Changes in the right side panel', async () => {
    render(<WorkspaceChips workspaceId="s1" />)
    act(() => {
      useExtensionsStore.getState().setGitItems(GIT_ITEMS)
      useExtensionsStore.getState().setPortsItems(PORTS_ITEMS)
    })
    await userEvent.setup().click(screen.getByRole('button', { name: /Git branch: main · \+2 −1/ }))
    expect(useSidePanelStore.getState().right).toBe('git')
    expect(gitPane()).toBeNull()
  })

  it('listening ports show as a plug in the top bar that opens the browser pane, and an ssh login shows on its pane', async () => {
    const paneId = useLayoutStore.getState().byWorkspace.s1.activePaneId
    const user = userOnFakeClock()
    const { container } = await renderSettled(
      <>
        <TopBar />
        <PaneChips paneId={paneId} />
      </>,
    )
    const sent = (workspaceChips: CoreItems['workspaceChips']): CoreItems => ({
      sidebar: [],
      paneChips: [{ extId: 'ports', paneId, id: 'ssh', text: 'deploy@build-box', tone: 'brand' }],
      workspaceChips,
    })
    act(() =>
      useExtensionsStore.getState().setPortsItems(
        sent([
          {
            ...PORTS_ITEMS.workspaceChips[0],
            items: [{ text: ':3000', url: 'http://127.0.0.1:3000/' }],
          },
        ]),
      ),
    )
    const topBar = container.querySelector('.topbar-right') as HTMLElement
    const chip = within(topBar).getByRole('button', {
      name: 'Listening ports: 1. Click to list them.',
    })
    const header = screen.getByRole('list', { name: 'Extension status' })
    expect(within(header).getByText('deploy@build-box')).toBeVisible()
    expect(within(header).queryByRole('button', { name: /Listening ports/ })).toBeNull()

    await user.click(chip)
    await user.click(
      await screen.findByRole('button', {
        name: 'Open http://127.0.0.1:3000/ in the browser pane',
      }),
    )
    expect(firstPaneOfKind(useLayoutStore.getState().byWorkspace.s1.root, 'browser')?.url).toBe(
      'http://127.0.0.1:3000/',
    )

    act(() => useExtensionsStore.getState().setPortsItems(sent([])))
    expect(screen.queryByRole('button', { name: /Listening ports/ })).toBeNull()
    expect(within(header).getByText('deploy@build-box')).toBeVisible()
  })

  it('names the process listening on each port, and copies and opens only the port URL', async () => {
    const user = userOnFakeClock()
    const { container } = await renderSettled(<TopBar />)
    act(() =>
      useExtensionsStore.getState().setPortsItems({
        ...PORTS_ITEMS,
        workspaceChips: [
          {
            ...PORTS_ITEMS.workspaceChips[0],
            text: '2',
            items: [
              { text: ':5173', detail: 'node', url: 'http://localhost:5173/' },
              { text: ':8000', url: 'http://localhost:8000/' },
            ],
          },
        ],
      }),
    )
    const topBar = container.querySelector('.topbar-right') as HTMLElement
    await user.click(within(topBar).getByRole('button', { name: /Listening ports: 2/ }))

    const named = await screen.findByRole('button', {
      name: 'Open http://localhost:5173/ in the browser pane',
    })
    expect(named).toHaveTextContent(':5173node')
    expect(within(named).getByText('node')).toHaveClass('pane-chip-item-detail')
    expect(
      screen.getByRole('button', { name: 'Open http://localhost:8000/ in the browser pane' }),
    ).toHaveTextContent(/^:8000$/)

    await user.click(screen.getByRole('button', { name: /Copy http:\/\/localhost:5173\// }))
    expect(await act(() => navigator.clipboard.readText())).toBe('http://localhost:5173/')
    await user.click(named)
    expect(firstPaneOfKind(useLayoutStore.getState().byWorkspace.s1.root, 'browser')?.url).toBe(
      'http://localhost:5173/',
    )
  })

  it('has no Git button in the top bar, because the branch chip is the one way in', () => {
    render(<PanelToggles />)
    expect(screen.queryByRole('button', { name: 'Git' })).toBeNull()
  })

  it('tells main when the shown pane changes, so the chip follows it', async () => {
    useExtensionsStore.getState().setGitItems(GIT_ITEMS)
    await renderSettled(<WorkspaceChips workspaceId="s1" />)
    vi.mocked(window.ostia.git.shown).mockClear()
    act(() => useLayoutStore.getState().focusPane('s1', 'p2'))
    expect(window.ostia.git.shown).toHaveBeenCalledTimes(1)
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

  it('shows the graph branches and file layout chosen in the panel, and switches back to a flat list', async () => {
    const user = userOnFakeClock()
    useSettingsStore.getState().setGit({ graphScope: 'all', changesView: 'tree' })
    await renderSettled(<GitSection />)
    expect(screen.getByRole('combobox', { name: 'Graph branches' })).toHaveTextContent(
      'All branches',
    )
    const layout = screen.getByRole('combobox', { name: 'Changed files layout' })
    expect(layout).toHaveTextContent('Folder tree')

    await user.click(layout)
    await user.click(await screen.findByRole('option', { name: 'Flat list' }))

    expect(useSettingsStore.getState().git.changesView).toBe('list')
  })
})

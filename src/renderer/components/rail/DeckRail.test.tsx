import '@testing-library/jest-dom/vitest'
import { allPanes, createPane, tabsOf } from '@/layout/tree'
import { languagesFrom } from '@/lib/extensions/languagePacks'
import * as blockActions from '@/lib/terminal/blockActions'
import { startNewWorkspace } from '@/lib/workspaces/newWorkspace'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { needsSandboxRestart, useSandboxStore } from '@/stores/app/sandboxStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { usePluginsStore } from '@/stores/extensions/pluginsStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useHibernateSkippedStore } from '@/stores/workspaces/hibernateSkippedStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useMergeConfirmStore } from '@/stores/workspaces/mergeConfirmStore'
import { useWindowsStore } from '@/stores/workspaces/windowsStore'
import { type Workspace, useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { zhHant } from '@shared/app/dict'
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SandboxFolderDialog } from '../sandbox/SandboxFolderDialog'
import { DeckRail } from './DeckRail'
import { HibernateSkippedDialog } from './HibernateSkippedDialog'

function seedWorkspaces(): void {
  const workspaces: Workspace[] = [
    { id: 's1', name: 'alpha', kind: 'agent', workDir: '/home/alpha', state: 'working' },
    { id: 's2', name: 'beta', kind: 'terminal', workDir: '/home/beta', state: 'idle' },
  ]
  useWorkspacesStore.setState({ workspaces, activeWorkspaceId: 's1' })
}

const resizeHandle = (): HTMLElement => screen.getByRole('separator', { name: 'Resize sidebar' })

function dragRailEdge(dx: number): boolean {
  const el = resizeHandle()
  const at = (type: string, clientX: number): boolean => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    return fireEvent(el, event)
  }
  const proceeded = at('pointerdown', 500)
  at('pointermove', 500 + dx / 2)
  at('pointermove', 500 + dx)
  at('pointerup', 500 + dx)
  return proceeded
}

function typeResumesAtOnce() {
  return vi
    .spyOn(blockActions, 'runWhenIdle')
    .mockImplementation((_paneId, _command, _timeoutMs, _allowed, _onGiveUp, onTyped) => {
      onTyped?.()
      return () => {}
    })
}

function rowFor(name: RegExp): HTMLElement {
  const main = screen.getByRole('button', { name })
  const tab = main.closest('.rail-tab')
  if (!tab) throw new Error('rail-tab wrapper not found')
  return tab as HTMLElement
}

describe('DeckRail', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let attentionInit: ReturnType<typeof useAttentionStore.getState>
  let mergeConfirmInit: ReturnType<typeof useMergeConfirmStore.getState>
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let pluginsInit: ReturnType<typeof usePluginsStore.getState>
  let windowsInit: ReturnType<typeof useWindowsStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    uiInit = useUIStore.getState()
    settingsInit = useSettingsStore.getState()
    layoutInit = useLayoutStore.getState()
    attentionInit = useAttentionStore.getState()
    mergeConfirmInit = useMergeConfirmStore.getState()
    blocksInit = useBlocksStore.getState()
    pluginsInit = usePluginsStore.getState()
    windowsInit = useWindowsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useUIStore.setState(uiInit, true)
    useSettingsStore.setState(settingsInit, true)
    useLayoutStore.setState(layoutInit, true)
    useAttentionStore.setState(attentionInit, true)
    useMergeConfirmStore.setState(mergeConfirmInit, true)
    useBlocksStore.setState(blocksInit, true)
    usePluginsStore.setState(pluginsInit, true)
    useWindowsStore.setState(windowsInit, true)
    useSandboxStore.setState({ enabled: {}, paneSandboxed: {} })
    useHibernateSkippedStore.setState({ skipped: null })
    vi.restoreAllMocks()
  })

  it('marks a scratch workspace row with a Scratch badge, and no other row', () => {
    seedWorkspaces()
    useWorkspacesStore.setState((st) => ({
      workspaces: [
        ...st.workspaces,
        {
          id: 's3',
          name: '1-aaaaaaaaaaaa',
          customName: 'Scratch 2',
          kind: 'scratch',
          workDir: '/tmp/ostia-scratch-1000/1-aaaaaaaaaaaa',
          state: 'idle',
        },
      ],
    }))
    render(<DeckRail />)
    expect(within(rowFor(/Scratch 2/)).getByText('Scratch')).toHaveClass('scratch-badge')
    expect(within(rowFor(/beta/)).queryByText('Scratch')).toBeNull()
  })

  it('wraps long workspace titles only when the setting is on', () => {
    seedWorkspaces()
    const { rerender } = render(<DeckRail />)
    expect(screen.getByText('alpha')).not.toHaveClass('wrap')

    act(() => useSettingsStore.getState().setWorkspaces({ wrapTitles: true }))
    rerender(<DeckRail />)
    expect(screen.getByText('alpha')).toHaveClass('wrap')
  })

  it('shows or hides each row detail by the sidebar settings', () => {
    seedWorkspaces()
    useWorkspacesStore.setState((st) => ({
      workspaces: st.workspaces.map((w) =>
        w.id === 's1' ? { ...w, description: 'fix login' } : w,
      ),
    }))
    const { rerender } = render(<DeckRail />)
    expect(screen.getByText('/home/alpha')).toBeInTheDocument()
    expect(screen.getByText('fix login')).toBeInTheDocument()

    act(() => useSettingsStore.getState().setSidebar({ showPath: false, showDescription: false }))
    rerender(<DeckRail />)
    expect(screen.queryByText('/home/alpha')).toBeNull()
    expect(screen.queryByText('fix login')).toBeNull()
    expect(rowFor(/alpha/).querySelector('.rail-meta')).toBeNull()
  })

  it('a pane moved to a new window rejoins its workspace when it comes back', () => {
    seedWorkspaces()
    useWindowsStore.getState().setInfo('1', false)
    const moved = {
      id: 'w-moved',
      name: 'api',
      workDir: '/home/api',
      state: 'idle' as const,
      unreadAt: 0,
      panes: [],
    }
    useWindowsStore.getState().setList([
      { windowId: '1', detached: false, workspaces: [] },
      { windowId: '2', detached: true, workspaces: [moved] },
    ])
    render(<DeckRail />)

    expect(screen.getAllByLabelText('In another window')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /api/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /alpha/ })).toBeInTheDocument()

    act(() =>
      useWindowsStore.getState().setList([{ windowId: '1', detached: false, workspaces: [] }]),
    )

    expect(screen.queryByLabelText('In another window')).toBeNull()
    expect(screen.queryByRole('button', { name: /api/ })).toBeNull()
  })

  it('collapses each row to its icon with no close button or details', () => {
    seedWorkspaces()
    useWorkspacesStore.setState((st) => ({
      workspaces: st.workspaces.map((w) =>
        w.id === 's1' ? { ...w, description: 'fix login' } : w,
      ),
    }))
    useUIStore.setState({ railCollapsed: true })
    render(<DeckRail />)

    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    expect(screen.queryByText('fix login')).toBeNull()
    expect(screen.queryByText('/home/alpha')).toBeNull()
    const row = rowFor(/alpha/)
    expect(row.querySelector('.tab-after')).toBeNull()
    expect(row.querySelector('.tab-lead-wrap .workspace-dot')).toHaveClass('working')
    expect(screen.getByRole('button', { name: 'beta' })).toBeInTheDocument()
  })

  it('shows the unread count in the row’s leading slot, before the title', () => {
    seedWorkspaces()
    const pane = createPane('terminal')
    useLayoutStore.setState({
      byWorkspace: { s1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })
    useAttentionStore.setState({ byPane: { [pane.id]: { state: 'done', unread: true, at: 1 } } })
    render(<DeckRail />)
    const badge = within(rowFor(/alpha/)).getByRole('img', { name: '1 unread' })
    expect(badge.closest('.tab-lead-wrap')).not.toBeNull()
    expect(
      badge.compareDocumentPosition(screen.getByText('alpha')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(within(rowFor(/beta/)).queryByRole('img', { name: /unread/ })).toBeNull()
  })

  it('marks a workspace that holds a locked tab and offers no close button for it', () => {
    seedWorkspaces()
    const kept = { ...createPane('terminal'), locked: true as const }
    useLayoutStore.setState({
      byWorkspace: { s1: { root: kept, activePaneId: kept.id, zoomedPaneId: null } },
    })
    render(<DeckRail />)
    expect(
      within(rowFor(/alpha/)).getByRole('img', { name: /Holds a locked tab/ }),
    ).toBeInTheDocument()
    expect(within(rowFor(/alpha/)).queryByRole('button', { name: 'Close' })).toBeNull()
    expect(within(rowFor(/beta/)).getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('marks a sandboxed workspace row, and no other row', async () => {
    seedWorkspaces()
    vi.mocked(window.ostia.sandbox.get).mockImplementation(async (id) => ({
      enabled: id === 's1',
      allowRead: [],
      domains: [],
      controls: {},
    }))
    render(<DeckRail />)
    expect(await within(rowFor(/alpha/)).findByRole('img', { name: 'Sandboxed' })).toBeVisible()
    expect(within(rowFor(/beta/)).queryByRole('img', { name: 'Sandboxed' })).toBeNull()
  })

  it('refuses to sandbox a workspace whose folder is the home folder, says why, and leaves the shell alone', async () => {
    seedWorkspaces()
    vi.mocked(window.ostia.sandbox.get).mockResolvedValue({
      enabled: false,
      allowRead: [],
      domains: [],
      controls: {},
    })
    vi.mocked(window.ostia.sandbox.setEnabled).mockResolvedValue({
      ok: false,
      reason: 'folder',
      problem: { folder: '/home/alpha', reason: 'home' },
    })
    useSandboxStore.getState().notePane('pa', false)
    const user = userEvent.setup()
    render(
      <>
        <DeckRail />
        <SandboxFolderDialog />
      </>,
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: /alpha/ }))
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Sandbox' }))
    expect(window.ostia.sandbox.setEnabled).toHaveBeenCalledWith('s1', true)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('This folder cannot be sandboxed')
    expect(dialog).toHaveTextContent('/home/alpha is your home folder')
    expect(dialog).toHaveTextContent('Open a project folder')
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(needsSandboxRestart(useSandboxStore.getState(), 's1', 'pa')).toBe(false)
    fireEvent.contextMenu(screen.getByRole('button', { name: /alpha/ }))
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Sandbox' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('keeps the close button on expanded rows', () => {
    seedWorkspaces()
    render(<DeckRail />)
    expect(within(rowFor(/alpha/)).getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('renders one row per workspace and marks the active one', () => {
    seedWorkspaces()
    render(<DeckRail />)

    expect(screen.getByRole('button', { name: /alpha/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /beta/ })).toBeInTheDocument()

    expect(rowFor(/alpha/)).toHaveClass('active')
    expect(rowFor(/beta/)).not.toHaveClass('active')
  })

  it('switches the active workspace when a row is clicked', async () => {
    seedWorkspaces()
    const setActive = vi
      .spyOn(useWorkspacesStore.getState(), 'setActive')
      .mockImplementation(() => {})
    const showWorkspaces = vi.spyOn(useUIStore.getState(), 'showWorkspaces')

    render(<DeckRail />)
    await userEvent.setup().click(screen.getByRole('button', { name: /beta/ }))

    expect(setActive).toHaveBeenCalledWith('s2')
    expect(showWorkspaces).toHaveBeenCalled()
  })

  it('closes the clicked workspace with its own id', async () => {
    seedWorkspaces()
    const closeWorkspace = vi
      .spyOn(useWorkspacesStore.getState(), 'closeWorkspace')
      .mockImplementation(() => {})

    render(<DeckRail />)
    await userEvent.setup().click(within(rowFor(/beta/)).getByRole('button', { name: 'Close' }))

    expect(closeWorkspace).toHaveBeenCalledWith('s2')
  })

  it('drives the status dot from the workspace state (working vs idle)', () => {
    seedWorkspaces()
    render(<DeckRail />)

    const workingDot = screen.getByRole('img', { name: 'Working' })
    const idleDot = screen.getByRole('img', { name: 'Idle' })

    expect(workingDot).toHaveClass('workspace-dot', 'working')
    expect(workingDot).not.toHaveClass('idle')
    expect(idleDot).toHaveClass('workspace-dot', 'idle')
    expect(idleDot).not.toHaveClass('working')
  })

  it('shows the moon only when every terminal of the workspace is hibernated', () => {
    seedWorkspaces()
    const asleep = { ...createPane('terminal'), hibernated: true as const }
    const alsoAsleep = { ...createPane('terminal'), hibernated: true as const }
    const editor = createPane('editor')
    const root = tabsOf(asleep.id, asleep, alsoAsleep, editor)
    useLayoutStore.setState({
      byWorkspace: { s1: { root, activePaneId: asleep.id, zoomedPaneId: null } },
    })
    render(<DeckRail />)
    expect(within(rowFor(/alpha/)).getByRole('img', { name: 'Hibernated' })).toBeInTheDocument()
  })

  it('keeps the kind icon when one hibernated tab sits among running terminals', () => {
    seedWorkspaces()
    const asleep = { ...createPane('terminal'), hibernated: true as const }
    const running = createPane('terminal')
    const root = tabsOf(running.id, running, asleep)
    useLayoutStore.setState({
      byWorkspace: { s1: { root, activePaneId: running.id, zoomedPaneId: null } },
    })
    render(<DeckRail />)
    expect(within(rowFor(/alpha/)).queryByRole('img', { name: 'Hibernated' })).toBeNull()
  })

  it('hibernates the workspace agents from its menu, and offers to resume them after', async () => {
    seedWorkspaces()
    const agent = {
      ...createPane('terminal'),
      resume: { agent: 'claude' as const, id: 'tok-1' },
    }
    const shell = createPane('terminal')
    useLayoutStore.setState({
      byWorkspace: {
        s1: { root: agent, activePaneId: agent.id, zoomedPaneId: null },
        s2: { root: shell, activePaneId: shell.id, zoomedPaneId: null },
      },
    })
    const blocks = useBlocksStore.getState()
    blocks.promptStart(agent.id, { line: 0 }, null)
    blocks.commandStart(agent.id, { line: 1 }, 'claude')
    render(<DeckRail />)
    const user = userEvent.setup()

    fireEvent.contextMenu(screen.getByRole('button', { name: /beta/ }))
    expect(await screen.findByRole('menuitem', { name: 'Hibernate agents' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await user.keyboard('{Escape}')

    fireEvent.contextMenu(screen.getByRole('button', { name: /alpha/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'Hibernate agents' }))
    await waitFor(() => expect(window.ostia.pty.hibernate).toHaveBeenCalledWith(agent.id))
    expect(within(rowFor(/alpha/)).getByRole('img', { name: 'Hibernated' })).toBeInTheDocument()

    const typed = typeResumesAtOnce()
    fireEvent.contextMenu(screen.getByRole('button', { name: /alpha/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'Resume agents' }))
    expect(within(rowFor(/alpha/)).queryByRole('img', { name: 'Hibernated' })).toBeNull()
    expect(typed.mock.calls.map(([id, command]) => [id, command])).toEqual([
      [agent.id, 'claude --resume tok-1'],
    ])
  })

  it('says how many agents it left running, and why, when they still have background work', async () => {
    seedWorkspaces()
    const agent = {
      ...createPane('terminal'),
      resume: { agent: 'claude' as const, id: 'tok-1' },
    }
    useLayoutStore.setState({
      byWorkspace: { s1: { root: agent, activePaneId: agent.id, zoomedPaneId: null } },
    })
    const blocks = useBlocksStore.getState()
    blocks.promptStart(agent.id, { line: 0 }, null)
    blocks.commandStart(agent.id, { line: 1 }, 'claude')
    vi.mocked(window.ostia.pty.hibernate).mockResolvedValueOnce('subagent')
    render(
      <>
        <DeckRail />
        <HibernateSkippedDialog />
      </>,
    )
    const user = userEvent.setup()

    fireEvent.contextMenu(screen.getByRole('button', { name: /alpha/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'Hibernate agents' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Agents left running: 1' })
    expect(within(dialog).getByText('Running a subagent: 1')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(within(rowFor(/alpha/)).queryByRole('img', { name: 'Hibernated' })).toBeNull()
  })

  it('hibernates and resumes the agents of every workspace of a group from the group header', async () => {
    const agentIn = (id: string) => ({
      ...createPane('terminal'),
      resume: { agent: 'claude' as const, id },
    })
    const api = agentIn('tok-api')
    const web = agentIn('tok-web')
    const outside = agentIn('tok-outside')
    const shell = createPane('terminal')
    useWorkspacesStore.setState({
      workspaces: [
        { id: 's1', name: 'api', kind: 'terminal', workDir: '/api', state: 'idle', groupId: 'g1' },
        { id: 's2', name: 'web', kind: 'terminal', workDir: '/web', state: 'idle', groupId: 'g1' },
        { id: 's3', name: 'notes', kind: 'terminal', workDir: '/notes', state: 'idle' },
      ],
      groups: [{ id: 'g1', name: 'backend' }],
      activeWorkspaceId: 's3',
    })
    useLayoutStore.setState({
      byWorkspace: {
        s1: { root: api, activePaneId: api.id, zoomedPaneId: null },
        s2: { root: tabsOf(web.id, web, shell), activePaneId: web.id, zoomedPaneId: null },
        s3: { root: outside, activePaneId: outside.id, zoomedPaneId: null },
      },
    })
    const blocks = useBlocksStore.getState()
    for (const pane of [api, web, outside]) {
      blocks.promptStart(pane.id, { line: 0 }, null)
      blocks.commandStart(pane.id, { line: 1 }, 'claude')
    }
    blocks.promptStart(shell.id, { line: 0 }, null)
    vi.mocked(window.ostia.pty.hibernate).mockClear()
    render(<DeckRail />)
    const user = userEvent.setup()
    const header = screen.getByRole('button', { name: /backend/ })
    const asleep = (): string[] =>
      Object.values(useLayoutStore.getState().byWorkspace)
        .flatMap((layout) => (layout ? allPanes(layout.root) : []))
        .filter((pane) => pane.hibernated)
        .map((pane) => pane.id)

    fireEvent.contextMenu(header)
    expect(await screen.findByRole('menuitem', { name: 'Hibernate agents' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Resume agents' })).toBeNull()
    await user.click(screen.getByRole('menuitem', { name: 'Hibernate agents' }))
    await waitFor(() => expect(asleep()).toEqual([api.id, web.id]))
    expect(vi.mocked(window.ostia.pty.hibernate).mock.calls.map(([id]) => id)).toEqual([
      api.id,
      web.id,
    ])

    fireEvent.contextMenu(header)
    expect(await screen.findByRole('menuitem', { name: 'Hibernate agents' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    const typed = typeResumesAtOnce()
    await user.click(screen.getByRole('menuitem', { name: 'Resume agents' }))
    expect(asleep()).toEqual([])
    expect(typed.mock.calls.map(([id, command]) => [id, command])).toEqual([
      [api.id, 'claude --resume tok-api'],
      [web.id, 'claude --resume tok-web'],
    ])
  })

  it('offers a merge when a workspace is dragged onto the middle of one with the same folder', async () => {
    const ask = vi.fn().mockResolvedValue(false)
    useMergeConfirmStore.setState({ ask })
    useWorkspacesStore.setState({
      workspaces: [
        { id: 's1', name: 'alpha', kind: 'terminal', workDir: '/home/app', state: 'idle' },
        { id: 's2', name: 'beta', kind: 'terminal', workDir: '/home/app', state: 'idle' },
        { id: 's3', name: 'gamma', kind: 'terminal', workDir: '/home/other', state: 'idle' },
      ],
      activeWorkspaceId: 's1',
    })
    render(<DeckRail />)
    const row = (name: RegExp) => rowFor(name).closest('.rail-row') as HTMLElement
    const target = row(/beta/)
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 200, 40))
    const dataTransfer = { types: ['application/x-ostia-workspace'], setData: vi.fn() }

    fireEvent.dragStart(row(/alpha/), { dataTransfer })
    await waitFor(() => expect(target).toHaveAttribute('data-mergeable'))
    expect(row(/gamma/)).not.toHaveAttribute('data-mergeable')

    const over = createEvent.dragOver(target, { dataTransfer })
    Object.defineProperty(over, 'clientY', { value: 120 })
    fireEvent(target, over)
    expect(target).toHaveAttribute('data-drop', 'merge')
    expect(within(target).getByText('Merge into beta')).toBeInTheDocument()

    fireEvent.drop(target, { dataTransfer })
    await waitFor(() => expect(ask).toHaveBeenCalledOnce())
    expect(ask.mock.calls[0][0]).toMatchObject({ source: 'alpha', target: 'beta' })
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['s1', 's2', 's3'])
  })

  it('reorders instead of merging when dropped on the edge of a mergeable row', async () => {
    const ask = vi.fn().mockResolvedValue(false)
    useMergeConfirmStore.setState({ ask })
    useWorkspacesStore.setState({
      workspaces: [
        { id: 's1', name: 'alpha', kind: 'terminal', workDir: '/home/app', state: 'idle' },
        { id: 's2', name: 'beta', kind: 'terminal', workDir: '/home/app', state: 'idle' },
      ],
      activeWorkspaceId: 's1',
    })
    render(<DeckRail />)
    const target = rowFor(/beta/).closest('.rail-row') as HTMLElement
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 200, 40))
    const dataTransfer = { types: ['application/x-ostia-workspace'], setData: vi.fn() }
    fireEvent.dragStart(rowFor(/alpha/).closest('.rail-row') as HTMLElement, { dataTransfer })
    await waitFor(() => expect(target).toHaveAttribute('data-mergeable'))
    const over = createEvent.dragOver(target, { dataTransfer })
    Object.defineProperty(over, 'clientY', { value: 138 })
    fireEvent(target, over)
    expect(target).toHaveAttribute('data-drop', 'after')
    fireEvent.drop(target, { dataTransfer })
    expect(ask).not.toHaveBeenCalled()
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['s2', 's1'])
  })

  it('gives interactive controls accessible names (a11y)', () => {
    seedWorkspaces()
    render(<DeckRail />)

    expect(screen.getByRole('button', { name: /alpha/ }).tagName).toBe('BUTTON')
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2)
  })

  it('the rail edge drags wider, shows more of the folder, survives a restart and resets', () => {
    const deepDir = '~/alpha-projects/beta-clients/gamma-service/delta-api'
    useWorkspacesStore.setState({
      workspaces: [
        {
          id: 's1',
          name: 'deep',
          kind: 'terminal',
          workDir: '/home/me/alpha-projects/beta-clients/gamma-service/delta-api',
          projectDir: deepDir,
          state: 'idle',
        },
      ],
      activeWorkspaceId: 's1',
    })
    vi.stubGlobal('innerWidth', 1280)
    HTMLElement.prototype.setPointerCapture = () => {}
    const observed: (() => void)[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observed.push(cb)
        }
        observe() {}
        disconnect() {}
      },
    )
    const railWidth = (): number =>
      Number.parseFloat(document.documentElement.style.getPropertyValue('--rail-w'))
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('rail-meta') ? railWidth() - 40 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('rail-meta-path') ? (this.textContent?.length ?? 0) * 7 : 0
    })
    const relayout = (): void =>
      act(() => {
        for (const cb of observed) cb()
      })

    const first = render(<DeckRail />)
    relayout()
    const path = (): HTMLElement => rowFor(/deep/).querySelector('.rail-meta-path') as HTMLElement
    expect(railWidth()).toBe(240)
    expect(path()).toHaveTextContent('delta-api')
    expect(path()).toHaveTextContent('…')
    const narrowText = path().textContent ?? ''

    expect(dragRailEdge(200)).toBe(false)
    relayout()
    expect(railWidth()).toBe(440)
    expect(resizeHandle()).toHaveAttribute('aria-valuenow', '440')
    expect(path().textContent).toBe(deepDir)
    expect(narrowText.length).toBeLessThan(deepDir.length)
    first.unmount()

    document.documentElement.style.removeProperty('--rail-w')
    render(<DeckRail />)
    expect(railWidth()).toBe(440)
    fireEvent.doubleClick(resizeHandle())
    expect(railWidth()).toBe(240)
  })

  it('dragging the rail far left collapses it and hides the handle; toggling restores the width', () => {
    seedWorkspaces()
    HTMLElement.prototype.setPointerCapture = () => {}
    const { container } = render(<DeckRail />)
    const rail = container.querySelector('.deck-rail') as HTMLElement
    dragRailEdge(60)
    expect(resizeHandle()).toHaveAttribute('aria-valuenow', '300')

    dragRailEdge(-260)
    expect(rail).toHaveClass('collapsed')
    expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).toBeNull()

    act(() => useUIStore.getState().toggleRail())
    expect(rail).not.toHaveClass('collapsed')
    expect(resizeHandle()).toHaveAttribute('aria-valuenow', '300')
    expect(document.documentElement.style.getPropertyValue('--rail-w')).toBe('300px')
  })

  describe('cmux-style rows', () => {
    const seedRows = () =>
      useWorkspacesStore.setState({
        workspaces: [
          {
            id: 's1',
            name: 'api',
            kind: 'terminal',
            workDir: '/src/api',
            state: 'idle',
            description: 'PR [#512](https://github.com/o/r/pull/512): fix refunds',
          },
          { id: 's2', name: 'web', kind: 'terminal', workDir: '/src/web', state: 'idle' },
        ],
        activeWorkspaceId: 's1',
      })

    it('shows the description with a working link outside the row button', () => {
      seedRows()
      render(<DeckRail />)
      const link = screen.getByRole('link', { name: '#512' })
      expect(link).toHaveAttribute('href', 'https://github.com/o/r/pull/512')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link.closest('button')).toBeNull()
      expect(screen.getByText(/fix refunds/)).toBeInTheDocument()
    })

    it('pins a workspace to the top from its menu', async () => {
      seedRows()
      render(<DeckRail />)
      fireEvent.contextMenu(screen.getByRole('button', { name: /web/ }))
      await userEvent.setup().click(await screen.findByRole('menuitem', { name: 'Pin to top' }))
      const [first] = useWorkspacesStore.getState().workspaces
      expect(first).toMatchObject({ id: 's2', pinned: true })
      expect(screen.getByLabelText('Pinned')).toBeInTheDocument()
    })

    it('edits a description from the menu', async () => {
      seedRows()
      render(<DeckRail />)
      fireEvent.contextMenu(screen.getByRole('button', { name: /web/ }))
      const user = userEvent.setup()
      await user.click(await screen.findByRole('menuitem', { name: 'Add description' }))
      await user.type(
        screen.getByRole('textbox', { name: 'Workspace description' }),
        'deploy{Enter}',
      )
      expect(useWorkspacesStore.getState().workspaces[1].description).toBe('deploy')
    })

    it('shows each row’s shortcut digit only while hints are on', () => {
      seedRows()
      const { rerender } = render(<DeckRail />)
      expect(screen.queryByText('2')).toBeNull()
      act(() => useUIStore.setState({ digitHints: true }))
      rerender(<DeckRail />)
      expect(screen.getByText('1')).toHaveClass('tab-digit')
      expect(screen.getByText('2')).toHaveClass('tab-digit')
    })
  })

  describe('workspace groups', () => {
    const WORKSPACE_DND = 'application/x-ostia-workspace'
    const GROUP_DND = 'application/x-ostia-workspace-group'

    const seedGroups = () =>
      useWorkspacesStore.setState({
        workspaces: [
          { id: 's1', name: 'solo', kind: 'terminal', workDir: '/solo', state: 'idle' },
          {
            id: 's2',
            name: 'api',
            kind: 'terminal',
            workDir: '/api',
            state: 'waiting',
            groupId: 'g90',
          },
          {
            id: 's3',
            name: 'web',
            kind: 'terminal',
            workDir: '/web',
            state: 'idle',
            groupId: 'g90',
          },
        ],
        groups: [{ id: 'g90', name: 'backend', color: 'blue' }],
        activeWorkspaceId: 's1',
      })

    const header = () => screen.getByRole('button', { name: /backend/ })

    function transfer(type: string) {
      return { types: [type], setData: vi.fn(), effectAllowed: '' }
    }

    function at(event: Event, clientY: number): Event {
      Object.defineProperty(event, 'clientY', { value: clientY })
      return event
    }

    function drag(from: Element, to: Element, type: string, clientY: number) {
      const dataTransfer = transfer(type)
      fireEvent.dragStart(from, { dataTransfer })
      fireEvent(to, at(createEvent.dragOver(to, { dataTransfer }), clientY))
      fireEvent(to, at(createEvent.drop(to, { dataTransfer }), clientY))
      fireEvent.dragEnd(from, { dataTransfer })
    }

    const rowTrigger = (name: RegExp) => rowFor(name).closest('.rail-row') as HTMLElement

    it('shows a header with the name and member count and indents its members', () => {
      seedGroups()
      render(<DeckRail />)
      expect(header()).toHaveAttribute('aria-expanded', 'true')
      expect(within(header()).getByLabelText('Members: 2')).toHaveTextContent('2')
      const group = header().closest('.rail-group') as HTMLElement
      expect(group).toHaveAttribute('data-color', 'blue')
      const members = group.querySelector('.rail-group-members') as HTMLElement
      expect(within(members).getByRole('button', { name: /api/ })).toBeInTheDocument()
      expect(within(members).getByRole('button', { name: /web/ })).toBeInTheDocument()
      expect(within(members).queryByRole('button', { name: /solo/ })).toBeNull()
    })

    it('collapses to the header alone and still shows that a member needs you', async () => {
      seedGroups()
      useLayoutStore.setState({
        byWorkspace: {
          s2: {
            root: { type: 'pane', id: 'p2', title: 'zsh', kind: 'terminal' },
            activePaneId: 'p2',
            zoomedPaneId: null,
          },
        },
      })
      useAttentionStore.setState({ byPane: { p2: { state: 'waiting', unread: true, at: 1 } } })
      render(<DeckRail />)

      await userEvent.setup().click(header())

      expect(useWorkspacesStore.getState().groups[0].collapsed).toBe(true)
      expect(header()).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('button', { name: /api/ })).toBeNull()
      expect(within(header()).getByRole('img', { name: 'Waiting for input' })).toBeInTheDocument()
      expect(within(header()).getByRole('img', { name: '1 unread' })).toBeInTheDocument()
    })

    it('adds a workspace to the group from the header button', async () => {
      seedGroups()
      render(<DeckRail />)
      const group = header().closest('.rail-group') as HTMLElement

      await userEvent
        .setup()
        .click(within(group).getByRole('button', { name: 'New workspace in group' }))

      const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState()
      expect(workspaces.map((w) => w.groupId)).toEqual([undefined, 'g90', 'g90', 'g90'])
      expect(workspaces[3].id).toBe(activeWorkspaceId)
      expect(header()).toHaveAttribute('aria-expanded', 'true')
    })

    it('names the group’s new workspace action in zh-Hant on the header and in its menu', async () => {
      seedGroups()
      usePluginsStore.setState({
        languages: languagesFrom([
          { extId: 'langpack-zh-hant', id: 'zh-Hant', label: '繁體中文', catalog: zhHant },
        ]),
      })
      useSettingsStore.setState({ locale: 'zh-Hant' })
      render(<DeckRail />)

      expect(screen.getByRole('button', { name: '在群組中新增工作區' })).toBeInTheDocument()
      fireEvent.contextMenu(header())
      expect(
        await screen.findByRole('menuitem', { name: '在群組中新增工作區' }),
      ).toBeInTheDocument()
    })

    it('adds a workspace to a collapsed group from the header menu and expands it', async () => {
      seedGroups()
      useWorkspacesStore.getState().setGroupCollapsed('g90', true)
      render(<DeckRail />)

      fireEvent.contextMenu(header())
      await userEvent
        .setup()
        .click(await screen.findByRole('menuitem', { name: 'New workspace in group' }))

      const { workspaces, groups } = useWorkspacesStore.getState()
      expect(workspaces.map((w) => w.groupId)).toEqual([undefined, 'g90', 'g90', 'g90'])
      expect(groups[0].collapsed).toBeUndefined()
    })

    it('leaves a workspace opened from inside a group ungrouped', () => {
      seedGroups()
      useWorkspacesStore.setState({ activeWorkspaceId: 's2' })

      startNewWorkspace()

      const { workspaces } = useWorkspacesStore.getState()
      expect(workspaces.map((w) => w.groupId)).toEqual([undefined, 'g90', 'g90', undefined])
    })

    it('moves a workspace to a new group from its menu and names it right away', async () => {
      seedGroups()
      render(<DeckRail />)
      fireEvent.contextMenu(screen.getByRole('button', { name: /solo/ }))
      const user = userEvent.setup()
      await user.click(await screen.findByRole('menuitem', { name: 'Move to new group' }))
      const name = screen.getByRole('textbox', { name: 'Group name' })
      await user.clear(name)
      await user.type(name, 'tools{Enter}')

      const { groups, workspaces } = useWorkspacesStore.getState()
      expect(groups.map((g) => g.name)).toEqual(['tools', 'backend'])
      expect(workspaces[0].groupId).toBe(groups[0].id)
      expect(screen.getByRole('button', { name: /tools/ })).toBeInTheDocument()
    })

    it('moves a workspace into another group from its menu and drops the group it emptied', async () => {
      seedGroups()
      useWorkspacesStore.getState().createGroup('s1', 'tools')
      render(<DeckRail />)
      fireEvent.contextMenu(screen.getByRole('button', { name: /solo/ }))
      const user = userEvent.setup()
      const trigger = await screen.findByRole('menuitem', { name: 'Move to group' })
      act(() => trigger.focus())
      await user.keyboard('{ArrowRight}')
      await user.click(await screen.findByRole('menuitem', { name: 'backend' }))

      const { groups, workspaces } = useWorkspacesStore.getState()
      expect(groups.map((g) => g.id)).toEqual(['g90'])
      expect(workspaces.find((w) => w.id === 's1')?.groupId).toBe('g90')
    })

    it('renames a group on double-click', async () => {
      seedGroups()
      render(<DeckRail />)
      const user = userEvent.setup()
      await user.dblClick(header())
      const name = screen.getByRole('textbox', { name: 'Group name' })
      await user.clear(name)
      await user.type(name, 'services{Enter}')
      expect(useWorkspacesStore.getState().groups[0].name).toBe('services')
    })

    it('deletes a group from its menu and keeps every member', async () => {
      seedGroups()
      render(<DeckRail />)
      fireEvent.contextMenu(header())
      await userEvent.setup().click(await screen.findByRole('menuitem', { name: 'Delete group' }))
      const { groups, workspaces } = useWorkspacesStore.getState()
      expect(groups).toEqual([])
      expect(workspaces.map((w) => [w.id, w.groupId])).toEqual([
        ['s1', undefined],
        ['s2', undefined],
        ['s3', undefined],
      ])
      expect(screen.getByRole('button', { name: /api/ })).toBeInTheDocument()
    })

    it('removes a workspace from its group from the row menu', async () => {
      seedGroups()
      render(<DeckRail />)
      fireEvent.contextMenu(screen.getByRole('button', { name: /api/ }))
      await userEvent
        .setup()
        .click(await screen.findByRole('menuitem', { name: 'Remove from group' }))
      const { workspaces } = useWorkspacesStore.getState()
      expect(workspaces.map((w) => [w.id, w.groupId])).toEqual([
        ['s1', undefined],
        ['s3', 'g90'],
        ['s2', undefined],
      ])
    })

    it('drags a member out of its group onto an ungrouped row', () => {
      seedGroups()
      render(<DeckRail />)
      drag(rowTrigger(/web/), rowTrigger(/solo/), WORKSPACE_DND, -1)
      const { workspaces } = useWorkspacesStore.getState()
      expect(workspaces.map((w) => [w.id, w.groupId])).toEqual([
        ['s3', undefined],
        ['s1', undefined],
        ['s2', 'g90'],
      ])
    })

    it('drags an ungrouped workspace into a group through its header', () => {
      seedGroups()
      render(<DeckRail />)
      const head = header().closest('.rail-group-head') as HTMLElement
      drag(rowTrigger(/solo/), head, WORKSPACE_DND, 1)
      const { workspaces } = useWorkspacesStore.getState()
      expect(workspaces.map((w) => [w.id, w.groupId])).toEqual([
        ['s1', 'g90'],
        ['s2', 'g90'],
        ['s3', 'g90'],
      ])
    })

    it('drags a whole group above another row', () => {
      seedGroups()
      render(<DeckRail />)
      const head = header().closest('.rail-group-head') as HTMLElement
      drag(head, rowTrigger(/solo/), GROUP_DND, -1)
      expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['s2', 's3', 's1'])
    })
  })
})

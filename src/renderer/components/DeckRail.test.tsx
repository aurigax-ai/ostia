import '@testing-library/jest-dom/vitest'
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
import { createPane } from '../layout/tree'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useMergeConfirmStore } from '../stores/mergeConfirmStore'
import { useSandboxStore } from '../stores/sandboxStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { type Workspace, useWorkspacesStore } from '../stores/workspacesStore'
import { DeckRail } from './DeckRail'

function seedWorkspaces(): void {
  const workspaces: Workspace[] = [
    { id: 's1', name: 'alpha', kind: 'agent', workDir: '/home/alpha', state: 'working' },
    { id: 's2', name: 'beta', kind: 'terminal', workDir: '/home/beta', state: 'idle' },
  ]
  useWorkspacesStore.setState({ workspaces, activeWorkspaceId: 's1' })
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

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    uiInit = useUIStore.getState()
    settingsInit = useSettingsStore.getState()
    layoutInit = useLayoutStore.getState()
    attentionInit = useAttentionStore.getState()
    mergeConfirmInit = useMergeConfirmStore.getState()
    blocksInit = useBlocksStore.getState()
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
    useSandboxStore.setState({ enabled: {} })
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

  it('swaps the workspace icon for a moon while one of its panes is hibernated', () => {
    seedWorkspaces()
    const sleeping = { ...createPane('terminal'), hibernated: true as const }
    const awake = createPane('terminal')
    useLayoutStore.setState({
      byWorkspace: {
        s1: { root: sleeping, activePaneId: sleeping.id, zoomedPaneId: null },
        s2: { root: awake, activePaneId: awake.id, zoomedPaneId: null },
      },
    })
    render(<DeckRail />)
    expect(within(rowFor(/alpha/)).getByRole('img', { name: 'Hibernated' })).toBeInTheDocument()
    expect(within(rowFor(/beta/)).queryByRole('img', { name: 'Hibernated' })).toBeNull()
  })

  it('hibernates the workspace agents from its menu, and offers to wake them after', async () => {
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

    fireEvent.contextMenu(screen.getByRole('button', { name: /alpha/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'Wake agents' }))
    expect(within(rowFor(/alpha/)).queryByRole('img', { name: 'Hibernated' })).toBeNull()
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

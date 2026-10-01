import '@testing-library/jest-dom/vitest'
import { cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useAttentionStore } from '../stores/attentionStore'
import { useLayoutStore } from '../stores/layoutStore'
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

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    uiInit = useUIStore.getState()
    settingsInit = useSettingsStore.getState()
    layoutInit = useLayoutStore.getState()
    attentionInit = useAttentionStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useUIStore.setState(uiInit, true)
    useSettingsStore.setState(settingsInit, true)
    useLayoutStore.setState(layoutInit, true)
    useAttentionStore.setState(attentionInit, true)
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
          workDir: '/tmp/pine-scratch-1000/1-aaaaaaaaaaaa',
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

    useSettingsStore.getState().setWorkspaces({ wrapTitles: true })
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

    useSettingsStore.getState().setSidebar({ showPath: false, showDescription: false })
    rerender(<DeckRail />)
    expect(screen.queryByText('/home/alpha')).toBeNull()
    expect(screen.queryByText('fix login')).toBeNull()
    expect(rowFor(/alpha/).querySelector('.tab-meta')).toBeEmptyDOMElement()
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
    const leaveSettings = vi.spyOn(useUIStore.getState(), 'leaveSettings')

    render(<DeckRail />)
    await userEvent.setup().click(screen.getByRole('button', { name: /beta/ }))

    expect(setActive).toHaveBeenCalledWith('s2')
    expect(leaveSettings).toHaveBeenCalled()
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
      useUIStore.setState({ digitHints: true })
      rerender(<DeckRail />)
      expect(screen.getByText('1')).toHaveClass('tab-digit')
      expect(screen.getByText('2')).toHaveClass('tab-digit')
    })
  })

  describe('workspace groups', () => {
    const WORKSPACE_DND = 'application/x-pine-workspace'
    const GROUP_DND = 'application/x-pine-workspace-group'

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

import type { NotificationEntry } from '@shared/types'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { findPane, resetIds } from '../layout/tree'
import type { PaneNode } from '../layout/types'
import { resetPointerView } from '../lib/pointerView'
import { signalPane } from '../lib/workspaceActivity'
import { useAttentionStore } from '../stores/attentionStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { DeckRail } from './DeckRail'
import { NotificationCenter } from './NotificationCenter'
import { Pane } from './Pane'
import { TooltipProvider } from './ui/tooltip'

function homeWorkspaceId(): string {
  if (useWorkspacesStore.getState().workspaces.length === 0)
    useWorkspacesStore.getState().addWorkspace()
  return useWorkspacesStore.getState().workspaces[0].id
}

let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>
let attentionInit: ReturnType<typeof useAttentionStore.getState>
let uiInit: ReturnType<typeof useUIStore.getState>

beforeAll(() => {
  workspacesInit = useWorkspacesStore.getState()
  layoutInit = useLayoutStore.getState()
  attentionInit = useAttentionStore.getState()
  uiInit = useUIStore.getState()
})

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
})

afterEach(() => {
  useWorkspacesStore.setState(workspacesInit, true)
  useLayoutStore.setState(layoutInit, true)
  useAttentionStore.setState(attentionInit, true)
  useUIStore.setState(uiInit, true)
  resetIds()
  resetPointerView()
  vi.restoreAllMocks()
})

function twoPanes(): { workspaceId: string; a: string; b: string } {
  const workspaceId = homeWorkspaceId()
  useLayoutStore.getState().ensure(workspaceId)
  const a = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
  useLayoutStore.getState().split(workspaceId, a, 'horizontal')
  const b = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
  return { workspaceId, a, b }
}

function paneNode(workspaceId: string, id: string): PaneNode {
  const node = findPane(useLayoutStore.getState().byWorkspace[workspaceId].root, id)
  if (!node) throw new Error('pane missing')
  return node
}

const signal = (paneId: string, message: string, at: number) =>
  act(() => {
    useAttentionStore.getState().dispatch(paneId, { type: 'notify', message, waiting: true, at })
  })

describe('sidebar unread badge', () => {
  it('shows the number of unread panes on the workspace row and hides it at zero', () => {
    const { workspaceId, a, b } = twoPanes()
    render(<DeckRail />)
    expect(screen.queryByRole('img', { name: /unread/ })).toBeNull()

    signal(a, 'one', 1)
    signal(b, 'two', 2)
    expect(screen.getByRole('img', { name: '2 unread' })).toHaveTextContent('2')

    act(() => useAttentionStore.getState().markAllRead())
    expect(screen.queryByRole('img', { name: /unread/ })).toBeNull()
    expect(workspaceId).toBeTruthy()
  })

  it('pops the badge only when the count grows, never on decrease', () => {
    const { a, b } = twoPanes()
    render(<DeckRail />)
    const badge = () => screen.getByRole('img', { name: /unread/ })

    signal(a, 'one', 1)
    expect(badge()).toHaveClass('pop')
    fireEvent.animationEnd(badge())
    expect(badge()).not.toHaveClass('pop')

    signal(b, 'two', 2)
    expect(badge()).toHaveClass('pop')
    fireEvent.animationEnd(badge())

    act(() => useAttentionStore.getState().dispatch(b, { type: 'view', at: 3 }))
    expect(badge()).toHaveTextContent('1')
    expect(badge()).not.toHaveClass('pop')
  })

  it('restarts the waiting dot pulse only when a new waiting signal arrives', () => {
    const { workspaceId, a } = twoPanes()
    act(() => useWorkspacesStore.getState().setState(workspaceId, 'waiting'))
    render(<DeckRail />)
    signal(a, 'first', 1)
    const first = screen.getByRole('img', { name: 'Waiting for input' })

    act(() => useWorkspacesStore.getState().setState(workspaceId, 'waiting'))
    expect(screen.getByRole('img', { name: 'Waiting for input' })).toBe(first)

    signal(a, 'second', 2)
    expect(screen.getByRole('img', { name: 'Waiting for input' })).not.toBe(first)
  })

  it('labels the error state so it is not conveyed by color alone', () => {
    const workspaceId = homeWorkspaceId()
    act(() => useWorkspacesStore.getState().setState(workspaceId, 'error'))
    render(<DeckRail />)
    expect(screen.getByRole('img', { name: 'Error' })).toHaveClass('error')
  })
})

describe('pane tab attention mark', () => {
  const setup = () => {
    const { workspaceId, a } = twoPanes()
    const view = render(<Pane tabs={[paneNode(workspaceId, a)]} shownId={a} active={false} />)
    const frame = view.container.querySelector('.pane') as HTMLElement
    const tab = view.container.querySelector('.pane-tab') as HTMLElement
    const blinking = () => view.container.querySelector('.pane-kind-blink')
    return { ...view, workspaceId, a, frame, tab, blinking }
  }

  it('never draws a border around the pane for a waiting agent', () => {
    const { a, container } = setup()
    signal(a, 'build finished', 1)
    expect(container.querySelector('.pane-attn-ring')).toBeNull()
  })

  it('marks the tab on the left of its icon and blinks the icon while a waiting signal is unread', () => {
    const { a, tab, blinking } = setup()
    expect(tab.querySelector('.pane-attn-mark')).toBeNull()
    expect(blinking()).toBeNull()

    signal(a, 'build finished', 1)
    const mark = tab.querySelector('.pane-attn-mark') as HTMLElement
    const icon = tab.querySelector('.pane-kind') as Element
    expect(tab).toHaveAttribute('data-attention', 'waiting')
    expect(mark).toHaveAccessibleName('Needs attention')
    expect(mark.compareDocumentPosition(icon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(blinking()).toBe(icon)
    expect(screen.getByText('build finished')).toBeInTheDocument()
  })

  it('keeps the mark while the agent still waits after the pane was viewed, without the blink', () => {
    const { a, tab, blinking } = setup()
    signal(a, 'build finished', 1)

    act(() => useAttentionStore.getState().dispatch(a, { type: 'view', at: 2 }))
    expect(tab.querySelector('.pane-attn-mark')).not.toBeNull()
    expect(blinking()).toBeNull()
    expect(screen.queryByText('build finished')).toBeNull()

    act(() => useAttentionStore.getState().dispatch(a, { type: 'input', at: 3 }))
    expect(tab.querySelector('.pane-attn-mark')).toBeNull()
  })

  it('stops the blink when the pointer moves over a pane that is not the active one', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const { a, frame, blinking } = setup()
    signal(a, 'needs you', 1)
    expect(blinking()).not.toBeNull()

    fireEvent.mouseEnter(frame)
    expect(blinking()).toBeNull()
    expect(useAttentionStore.getState().byPane[a]?.state).toBe('waiting')
  })

  it('does not blink a pane under the pointer, and blinks again once the pointer left', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const { a, frame, blinking } = setup()
    const waiting = (message: string, at: number) =>
      act(() => signalPane(a, { type: 'notify', message, waiting: true, at }))

    fireEvent.mouseMove(frame)
    waiting('first', 1)
    expect(blinking()).toBeNull()

    fireEvent.mouseLeave(frame)
    waiting('second', 2)
    expect(blinking()).not.toBeNull()
  })

  it('keeps blinking while the window is not focused, even with the pointer over the pane', () => {
    const { a, frame, blinking } = setup()
    signal(a, 'needs you', 1)

    fireEvent.mouseEnter(frame)
    expect(blinking()).not.toBeNull()
  })

  it('replays the blink for a new signal but not for unrelated re-renders', () => {
    const { workspaceId, a, rerender, blinking } = setup()
    signal(a, 'first', 1)
    const icon = blinking()
    expect(icon).not.toBeNull()

    rerender(<Pane tabs={[paneNode(workspaceId, a)]} shownId={a} active />)
    expect(blinking()).toBe(icon)

    signal(a, 'second', 2)
    expect(blinking()).not.toBeNull()
    expect(blinking()).not.toBe(icon)
  })

  it('gives a done unread pane a quiet mark and no blink', () => {
    const { a, frame, tab, blinking } = setup()
    act(() => useAttentionStore.getState().dispatch(a, { type: 'set', state: 'done', at: 1 }))
    expect(blinking()).toBeNull()
    expect(frame).toHaveAttribute('data-attention', 'done')
    expect(tab).toHaveAttribute('data-attention', 'done')
    expect(screen.getByRole('img', { name: 'Unread' })).toBeInTheDocument()
  })
})

describe('NotificationCenter', () => {
  const entries = (paneId: string): NotificationEntry[] => [
    {
      id: 'n2',
      ts: '2026-09-28T10:05:00Z',
      kind: 'done',
      title: 'build finished',
      from: 'x',
      paneId,
    },
    {
      id: 'n1',
      ts: '2026-09-28T10:00:00Z',
      kind: 'message',
      title: 'Tests',
      body: 'all passed',
      from: 'x',
      paneId: 'gone',
    },
  ]

  const renderBell = () =>
    render(
      <TooltipProvider>
        <NotificationCenter />
      </TooltipProvider>,
    )

  it('shows the unread count on the bell', () => {
    const { a, b } = twoPanes()
    renderBell()
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument()
    signal(a, 'x', 1)
    signal(b, 'y', 2)
    expect(screen.getByRole('button', { name: 'Notifications, 2 unread' })).toBeInTheDocument()
  })

  it('lists the real notify log newest first and jumps to the pane of an entry', async () => {
    const { workspaceId, a, b } = twoPanes()
    signal(a, 'build finished', 1)
    vi.mocked(window.pine.notifications.list).mockResolvedValue(entries(a))
    renderBell()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /Notifications/ }))
    const list = await screen.findByRole('list', { name: 'Notifications' })
    const rows = within(list).getAllByRole('button')
    expect(rows[0]).toHaveTextContent('build finished')
    expect(within(list).getByRole('list', { name: 'home' })).toContainElement(rows[0])
    expect(rows[1]).toHaveTextContent('Tests: all passed')
    expect(rows[1]).toHaveTextContent('Closed pane')
    expect(rows[1]).toBeDisabled()

    expect(useLayoutStore.getState().byWorkspace[workspaceId].activePaneId).toBe(b)
    await user.click(rows[0])
    expect(useLayoutStore.getState().byWorkspace[workspaceId].activePaneId).toBe(a)
    expect(useAttentionStore.getState().byPane[a].unread).toBe(false)
  })

  it('filters by tab and groups entries by workspace', async () => {
    const { a } = twoPanes()
    vi.mocked(window.pine.notifications.list).mockResolvedValue([
      {
        id: 'w',
        ts: '2026-09-28T10:06:00Z',
        kind: 'waiting',
        title: 'needs input',
        from: 'x',
        paneId: a,
      },
      {
        id: 'd',
        ts: '2026-09-28T10:05:00Z',
        kind: 'done',
        title: 'all done',
        from: 'x',
        paneId: a,
      },
    ])
    renderBell()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Notifications/ }))
    await screen.findByText('needs input')

    await user.click(screen.getByRole('tab', { name: /Finished/ }))
    expect(screen.queryByText('needs input')).toBeNull()
    expect(screen.getByText('all done')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /Needs you/ }))
    expect(screen.getByText('needs input')).toBeInTheDocument()
    expect(screen.queryByText('all done')).toBeNull()
  })

  it('clear all empties the log in main and marks every pane read', async () => {
    const { a } = twoPanes()
    signal(a, 'build finished', 1)
    vi.mocked(window.pine.notifications.list).mockResolvedValue(entries(a))
    renderBell()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /Notifications/ }))
    await screen.findByRole('list', { name: 'Notifications' })
    await user.click(screen.getByRole('button', { name: 'Clear all' }))

    expect(window.pine.notifications.clear).toHaveBeenCalledOnce()
    expect(useAttentionStore.getState().byPane[a].unread).toBe(false)
    await waitFor(() => expect(screen.getByText('No notifications')).toBeInTheDocument())
  })

  it('reloads the list when main reports a change while open', async () => {
    twoPanes()
    let changed: () => void = () => {}
    vi.mocked(window.pine.notifications.onChanged).mockImplementation((cb) => {
      changed = cb
      return () => {}
    })
    vi.mocked(window.pine.notifications.list).mockResolvedValue([])
    renderBell()
    await userEvent.setup().click(screen.getByRole('button', { name: /Notifications/ }))
    await screen.findByText('No notifications')

    vi.mocked(window.pine.notifications.list).mockResolvedValue([
      { id: 'n9', ts: '2026-09-28T10:00:00Z', kind: 'message', title: 'fresh', from: 'x' },
    ])
    act(() => changed())
    expect(await screen.findByText('fresh')).toBeInTheDocument()
  })

  it('names the extension on its notifications and opens its panel at their path on click', async () => {
    const { workspaceId } = twoPanes()
    const extInit = useExtensionsStore.getState()
    useExtensionsStore.setState({
      list: [
        {
          id: 'keeper',
          name: 'Keeper',
          version: '1.0.0',
          description: '',
          builtin: true,
          enabled: true,
          status: 'running',
          requested: [],
          granted: [],
          unapproved: [],
          commands: [],
          panel: { title: 'Keeper', icon: 'shield' },
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
          agentSkills: [],
          agentHooks: [],
          iconThemes: [],
          keymaps: [],
        },
      ],
    })
    vi.mocked(window.pine.notifications.list).mockResolvedValue([
      {
        id: 'k1',
        ts: '2026-09-28T10:00:00Z',
        kind: 'message',
        title: 'Keeper needs approval',
        from: 'extension:keeper',
        extId: 'keeper',
        panelPath: '/approvals',
      },
    ])
    try {
      renderBell()
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: /Notifications/ }))
      const row = within(await screen.findByRole('list', { name: 'Notifications' })).getByRole(
        'button',
      )
      expect(row).toHaveTextContent(/^Keeper/)
      expect(row).toBeEnabled()
      await user.click(row)
      const layout = useLayoutStore.getState().byWorkspace[workspaceId]
      expect(paneNode(workspaceId, layout.activePaneId)).toMatchObject({
        kind: 'extension',
        extensionId: 'keeper',
      })
      expect(useExtensionsStore.getState().panelNav[layout.activePaneId]?.path).toBe('/approvals')
    } finally {
      useExtensionsStore.setState(extInit, true)
    }
  })
})

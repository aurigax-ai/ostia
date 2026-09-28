import type { NotificationEntry } from '@shared/types'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { findPane, resetIds } from '../layout/tree'
import type { PaneNode } from '../layout/types'
import { useAttentionStore } from '../stores/attentionStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { useUIStore } from '../stores/uiStore'
import { DeckRail } from './DeckRail'
import { NotificationCenter } from './NotificationCenter'
import { Pane } from './Pane'
import { TooltipProvider } from './ui/tooltip'

let sessionsInit: ReturnType<typeof useSessionsStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>
let attentionInit: ReturnType<typeof useAttentionStore.getState>
let uiInit: ReturnType<typeof useUIStore.getState>

beforeAll(() => {
  sessionsInit = useSessionsStore.getState()
  layoutInit = useLayoutStore.getState()
  attentionInit = useAttentionStore.getState()
  uiInit = useUIStore.getState()
})

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
})

afterEach(() => {
  useSessionsStore.setState(sessionsInit, true)
  useLayoutStore.setState(layoutInit, true)
  useAttentionStore.setState(attentionInit, true)
  useUIStore.setState(uiInit, true)
  resetIds()
  vi.restoreAllMocks()
})

function twoPanes(): { sessionId: string; a: string; b: string } {
  const sessionId = useSessionsStore.getState().sessions[0].id
  useLayoutStore.getState().ensure(sessionId)
  const a = useLayoutStore.getState().bySession[sessionId].activePaneId
  useLayoutStore.getState().split(sessionId, a, 'horizontal')
  const b = useLayoutStore.getState().bySession[sessionId].activePaneId
  return { sessionId, a, b }
}

function paneNode(sessionId: string, id: string): PaneNode {
  const node = findPane(useLayoutStore.getState().bySession[sessionId].root, id)
  if (!node) throw new Error('pane missing')
  return node
}

const signal = (paneId: string, message: string, at: number) =>
  act(() => {
    useAttentionStore.getState().dispatch(paneId, { type: 'notify', message, waiting: true, at })
  })

describe('sidebar unread badge', () => {
  it('shows the number of unread panes on the session row and hides it at zero', () => {
    const { sessionId, a, b } = twoPanes()
    render(<DeckRail />)
    expect(screen.queryByRole('img', { name: /unread/ })).toBeNull()

    signal(a, 'one', 1)
    signal(b, 'two', 2)
    expect(screen.getByRole('img', { name: '2 unread' })).toHaveTextContent('2')

    act(() => useAttentionStore.getState().markAllRead())
    expect(screen.queryByRole('img', { name: /unread/ })).toBeNull()
    expect(sessionId).toBeTruthy()
  })

  it('labels the error state so it is not conveyed by color alone', () => {
    const sessionId = useSessionsStore.getState().sessions[0].id
    act(() => useSessionsStore.getState().setState(sessionId, 'error'))
    render(<DeckRail />)
    expect(screen.getByRole('img', { name: 'Error' })).toHaveClass('error')
  })
})

describe('pane attention ring', () => {
  it('rings a pane that is waiting unread and shows its message, then clears when viewed', () => {
    const { sessionId, a } = twoPanes()
    const { container } = render(<Pane pane={paneNode(sessionId, a)} active={false} />)
    const frame = container.querySelector('.pane')
    expect(frame).not.toHaveClass('attn-ring')

    signal(a, 'build finished', 1)
    expect(frame).toHaveClass('attn-ring')
    expect(screen.getByRole('img', { name: 'Needs attention' })).toBeInTheDocument()
    expect(screen.getByText('build finished')).toBeInTheDocument()

    act(() => useAttentionStore.getState().dispatch(a, { type: 'view', at: 2 }))
    expect(frame).not.toHaveClass('attn-ring')
    expect(screen.queryByText('build finished')).toBeNull()
  })

  it('gives a done unread pane a quiet marker instead of the ring', () => {
    const { sessionId, a } = twoPanes()
    const { container } = render(<Pane pane={paneNode(sessionId, a)} active={false} />)
    act(() => useAttentionStore.getState().dispatch(a, { type: 'set', state: 'done', at: 1 }))
    const frame = container.querySelector('.pane')
    expect(frame).not.toHaveClass('attn-ring')
    expect(frame).toHaveAttribute('data-attention', 'done')
    expect(screen.getByRole('img', { name: 'Unread' })).toBeInTheDocument()
  })
})

describe('NotificationCenter', () => {
  const entries = (paneId: string): NotificationEntry[] => [
    { id: 'n2', ts: '2026-09-28T10:05:00Z', title: 'build finished', from: 'x', paneId },
    {
      id: 'n1',
      ts: '2026-09-28T10:00:00Z',
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
    const { sessionId, a, b } = twoPanes()
    signal(a, 'build finished', 1)
    vi.mocked(window.pine.notifications.list).mockResolvedValue(entries(a))
    renderBell()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /Notifications/ }))
    const list = await screen.findByRole('list', { name: 'Notifications' })
    const rows = within(list).getAllByRole('button')
    expect(rows[0]).toHaveTextContent('build finished')
    expect(rows[0]).toHaveTextContent(/^home · /)
    expect(rows[1]).toHaveTextContent('Tests: all passed')
    expect(rows[1]).toHaveTextContent('Closed pane')
    expect(rows[1]).toBeDisabled()

    expect(useLayoutStore.getState().bySession[sessionId].activePaneId).toBe(b)
    await user.click(rows[0])
    expect(useLayoutStore.getState().bySession[sessionId].activePaneId).toBe(a)
    expect(useAttentionStore.getState().byPane[a].unread).toBe(false)
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
      { id: 'n9', ts: '2026-09-28T10:00:00Z', title: 'fresh', from: 'x' },
    ])
    act(() => changed())
    expect(await screen.findByText('fresh')).toBeInTheDocument()
  })

  it('names the extension on its notifications and opens its panel on click', async () => {
    const { sessionId } = twoPanes()
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
        },
      ],
    })
    vi.mocked(window.pine.notifications.list).mockResolvedValue([
      {
        id: 'k1',
        ts: '2026-09-28T10:00:00Z',
        title: 'Keeper needs approval',
        from: 'extension:keeper',
        extId: 'keeper',
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
      const layout = useLayoutStore.getState().bySession[sessionId]
      expect(paneNode(sessionId, layout.activePaneId)).toMatchObject({
        kind: 'extension',
        extensionId: 'keeper',
      })
    } finally {
      useExtensionsStore.setState(extInit, true)
    }
  })
})

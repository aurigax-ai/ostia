import type { MailItem } from '@shared/agents/mailApi'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MailCount } from '@/components/common/MailCount'
import { TabFace } from '@/components/panes/TabFace'
import { WorkspaceBadges } from '@/components/sidebar/WorkspaceBadges'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createPane } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import { useMailStore } from '@/stores/agents/mailStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

const queued = (id: string, over: Partial<MailItem> = {}): MailItem => ({
  id,
  state: 'queued',
  from: { label: 'ostia' },
  ts: new Date().toISOString(),
  pending: 'idle-no-wake',
  ...over,
})

const failed = (id: string, reason: string): MailItem => ({
  id,
  state: 'failed',
  from: { label: 'ostia' },
  ts: new Date().toISOString(),
  reason,
})

function show(ui: JSX.Element) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

beforeEach(() => {
  useMailStore.setState({ byPane: {} })
  vi.mocked(window.ostia.mail.dismiss).mockClear()
})

afterEach(cleanup)

describe('MailCount', () => {
  it('shows nothing for a pane without undelivered or failed mail', () => {
    show(<MailCount paneIds={['p1']} />)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('counts a pane’s undelivered messages, and says one message in the singular', () => {
    useMailStore.setState({ byPane: { p1: [queued('a'), queued('b')], p2: [queued('c')] } })
    const { unmount } = show(<MailCount paneIds={['p1']} />)
    expect(screen.getByRole('img', { name: '2 unread messages for this agent' })).toHaveTextContent(
      '2',
    )
    unmount()
    show(<MailCount paneIds={['p2']} />)
    expect(screen.getByRole('img', { name: '1 unread message for this agent' })).toBeInTheDocument()
  })

  it('adds up the panes of a workspace', () => {
    useMailStore.setState({ byPane: { p1: [queued('a')], p2: [queued('b'), queued('c')] } })
    show(<MailCount paneIds={['p1', 'p2', 'p3']} />)
    expect(
      screen.getByRole('img', { name: '3 unread messages for this agent' }),
    ).toBeInTheDocument()
  })

  it('lists each message with its sender, age and why it waits when the mark is hovered', async () => {
    useMailStore.setState({
      byPane: { p1: [queued('a', { pending: 'hibernated', from: { label: 'review bot' } })] },
    })
    show(<MailCount paneIds={['p1']} />)
    await userEvent.hover(screen.getByRole('img', { name: '1 unread message for this agent' }))
    expect(
      await screen.findAllByText('review bot · 0s · the agent is hibernated'),
    ).not.toHaveLength(0)
  })

  it('shows a failed message as an error until it is dismissed, and dismisses on a click', async () => {
    useMailStore.setState({ byPane: { p1: [failed('a', 'expired:hibernated')] } })
    show(<MailCount paneIds={['p1']} />)
    const mark = screen.getByRole('img', { name: '1 message could not be delivered' })
    expect(mark.className).toContain('destructive')
    fireEvent.click(mark)
    expect(window.ostia.mail.dismiss).toHaveBeenCalledWith('p1')
  })

  it('does not dismiss anything when only undelivered mail is shown', () => {
    useMailStore.setState({ byPane: { p1: [queued('a')] } })
    show(<MailCount paneIds={['p1']} />)
    fireEvent.click(screen.getByRole('img', { name: '1 unread message for this agent' }))
    expect(window.ostia.mail.dismiss).not.toHaveBeenCalled()
  })
})

describe('where the mark shows', () => {
  it('sits on a pane’s tab face, and never sets its attention', () => {
    const pane: PaneNode = { ...createPane('terminal', 'worker'), id: 'tab-pane' }
    useMailStore.setState({ byPane: { 'tab-pane': [queued('a')] } })
    const { container } = show(<TabFace pane={pane} />)
    expect(screen.getByRole('img', { name: '1 unread message for this agent' })).toBeInTheDocument()
    expect(container.querySelector('.pane-attn-mark')).toBeNull()
  })

  it('sits on a workspace row with the count of all its panes', () => {
    useWorkspacesStore.getState().addWorkspace()
    const workspace = useWorkspacesStore.getState().workspaces[0]
    useLayoutStore.getState().ensure(workspace.id)
    const layout = useLayoutStore.getState().byWorkspace[workspace.id]
    const paneId = layout.activePaneId
    useMailStore.setState({ byPane: { [paneId]: [queued('a'), queued('b')] } })
    show(<WorkspaceBadges workspace={workspace} />)
    expect(
      screen.getByRole('img', { name: '2 unread messages for this agent' }),
    ).toBeInTheDocument()
  })
})

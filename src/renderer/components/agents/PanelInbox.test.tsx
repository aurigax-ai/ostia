import '@testing-library/jest-dom/vitest'
import type { QuestionRequest } from '@shared/agents/questions'
import type { ApprovalRequest } from '@shared/permissions/approvals'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPane } from '@/lib/layout/tree'
import { useApprovalsStore } from '@/stores/agents/approvalsStore'
import { useQuestionsStore } from '@/stores/agents/questionsStore'
import { useInboxStore } from '@/stores/extensions/inboxStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { PanelInbox } from './PanelInbox'

const reveal = vi.hoisted(() => vi.fn(() => true))

vi.mock('@/lib/attention/workspaceActivity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/attention/workspaceActivity')>()),
  revealPane: reveal,
}))

const question = (id: string, paneId: string, text: string, at: number): QuestionRequest => ({
  id,
  paneId,
  question: text,
  context: '',
  choices: ['yes', 'no'],
  mode: 'single',
  at,
})

const approval = (
  id: string,
  workspaceId: string,
  paneId: string,
  at: number,
): ApprovalRequest => ({
  id,
  paneId,
  workspaceId,
  caps: ['shell'],
  action: 'Resume Agent',
  detail: '',
  at,
})

describe('PanelInbox', () => {
  const stores = [
    useApprovalsStore,
    useInboxStore,
    useLayoutStore,
    useQuestionsStore,
    useWorkspacesStore,
  ] as const
  let inits: unknown[]

  beforeAll(() => {
    inits = stores.map((store) => store.getState())
  })

  afterEach(() => {
    cleanup()
    reveal.mockClear()
    stores.forEach((store, i) => {
      store.setState(inits[i] as never, true)
    })
    vi.restoreAllMocks()
  })

  function seed(): void {
    const api = { ...createPane('terminal'), id: 'p-api', title: 'claude' }
    const web = { ...createPane('terminal'), id: 'p-web', title: 'zsh' }
    useWorkspacesStore.setState({
      workspaces: [
        { id: 'w-api', name: 'api', kind: 'terminal', workDir: '~/work/api', state: 'waiting' },
        { id: 'w-web', name: 'web', kind: 'terminal', workDir: '~/work/web', state: 'idle' },
      ],
      activeWorkspaceId: 'w-api',
    })
    useLayoutStore.setState({
      byWorkspace: {
        'w-api': { root: api, activePaneId: api.id, zoomedPaneId: null },
        'w-web': { root: web, activePaneId: web.id, zoomedPaneId: null },
      },
    })
  }

  const note = { id: 'abcdefghij', text: 'Set STRIPE_KEY in .env.local', paneId: 'p-api', at: 20 }

  function fill(): void {
    useQuestionsStore.setState({
      pending: [
        question('q-late', 'p-api', 'Run the migration?', 30),
        question('q-web', 'p-web', 'Ship the storefront?', 5),
      ],
    })
    useApprovalsStore.setState({
      pending: [approval('a-mid', 'w-api', 'p-api', 10), approval('a-web', 'w-web', 'p-web', 1)],
    })
    useInboxStore.getState().setEntries([
      { extId: 'activity', workspaceId: 'w-api', items: [note] },
      {
        extId: 'activity',
        workspaceId: 'w-web',
        items: [{ ...note, id: 'bcdefghijk', paneId: 'p-web' }],
      },
    ])
  }

  it('says nothing waits when the workspace has no question, permission or note', () => {
    seed()
    render(<PanelInbox extId="activity" workspaceId="w-api" />)
    expect(screen.getByText('Nothing waits for you.')).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('lists this workspace’s cards in one flat list, oldest first, with the tab and the age and no heading', () => {
    seed()
    fill()
    render(<PanelInbox extId="activity" workspaceId="w-api" />)
    const list = screen.getByRole('list', { name: 'Inbox' })
    const cards = within(list).getAllByRole('listitem')
    expect(cards).toHaveLength(3)
    expect(cards[0]).toHaveTextContent('Resume Agent')
    expect(cards[1]).toHaveTextContent('Set STRIPE_KEY in .env.local')
    expect(cards[2]).toHaveTextContent('Run the migration?')
    for (const card of cards) expect(card).toHaveTextContent('claude')
    expect(screen.queryByText('Ship the storefront?')).toBeNull()
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
    expect(cards[2]).not.toHaveTextContent('~/work/api')
  })

  it('shows the pane of a card on a click outside its controls and keeps the controls working', async () => {
    seed()
    fill()
    const user = userEvent.setup()
    render(<PanelInbox extId="activity" workspaceId="w-api" />)
    const permission = screen.getByRole('region', { name: 'Agent permission request' })
    await user.click(within(permission).getByText('Resume Agent'))
    expect(reveal).toHaveBeenCalledWith('p-api')
    reveal.mockClear()
    await user.click(within(permission).getByRole('button', { name: 'Allow once' }))
    expect(window.ostia.approvals.answer).toHaveBeenCalledWith('a-mid', 'once')
    expect(reveal).not.toHaveBeenCalled()
  })

  it('answers a question in the card through the questions store', async () => {
    seed()
    fill()
    const user = userEvent.setup()
    render(<PanelInbox extId="activity" workspaceId="w-api" />)
    const card = document.querySelector('[data-question="q-late"]') as HTMLElement
    await user.click(within(card).getByRole('radio', { name: 'yes' }))
    await user.click(within(card).getByRole('button', { name: 'Send' }))
    expect(window.ostia.questions.answer).toHaveBeenCalledWith('q-late', { choices: [0], text: '' })
    expect(window.ostia.approvals.answer).not.toHaveBeenCalled()
  })

  it('marks a needs-you note done through the owner-window action and shows its pane on a click', async () => {
    seed()
    fill()
    const user = userEvent.setup()
    render(<PanelInbox extId="activity" workspaceId="w-api" />)
    const card = screen.getByRole('article', { name: 'Note from claude' })
    await user.click(within(card).getByText('Set STRIPE_KEY in .env.local'))
    expect(reveal).toHaveBeenCalledWith('p-api')
    reveal.mockClear()
    await user.click(within(card).getByRole('button', { name: 'Mark done' }))
    expect(window.ostia.extensions.inboxAction).toHaveBeenCalledWith(
      'activity',
      'w-api',
      'abcdefghij',
    )
    expect(reveal).not.toHaveBeenCalled()
  })

  it('names a note whose pane is gone as a closed pane', () => {
    seed()
    useInboxStore
      .getState()
      .setEntries([
        { extId: 'activity', workspaceId: 'w-api', items: [{ ...note, paneId: 'gone' }] },
      ])
    render(<PanelInbox extId="activity" workspaceId="w-api" />)
    const card = screen.getByRole('article')
    expect(card).toHaveTextContent('Set STRIPE_KEY in .env.local')
    expect(card).toHaveTextContent('Closed pane')
  })
})

import type { ApprovalRequest } from '@shared/approvals'
import type { ExtensionInfo, WorkspaceChip } from '@shared/extensions'
import type { QuestionRequest } from '@shared/questions'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPane } from '../layout/tree'
import { registerTerminal } from '../lib/terminalHandles'
import { useApprovalsStore } from '../stores/approvalsStore'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useQuestionsStore } from '../stores/questionsStore'
import { useUIStore } from '../stores/uiStore'
import { useWindowsStore } from '../stores/windowsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { DashboardPanel } from './DashboardPanel'

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
  panel: null,
  paneChips: [],
  workspaceChips: [{ id: 'branch', title: 'Git branch' }],
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
}

function question(id: string, paneId: string, text: string, at: number): QuestionRequest {
  return { id, paneId, question: text, context: '', choices: ['yes', 'no'], mode: 'single', at }
}

const APPROVAL: ApprovalRequest = {
  id: 'approval-1',
  paneId: 'p-api',
  workspaceId: 'w-api',
  caps: ['shell'],
  action: 'Resume Agent',
  detail: '',
  at: 20,
}

describe('DashboardPanel', () => {
  const stores = [
    useApprovalsStore,
    useAttentionStore,
    useBlocksStore,
    useExtensionsStore,
    useLayoutStore,
    useQuestionsStore,
    useUIStore,
    useWindowsStore,
    useWorkspacesStore,
  ] as const
  let inits: unknown[]
  let offTerminals: (() => void)[] = []

  beforeAll(() => {
    inits = stores.map((store) => store.getState())
  })

  afterEach(() => {
    cleanup()
    for (const off of offTerminals) off()
    offTerminals = []
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
        {
          id: 'w-api',
          name: 'api',
          kind: 'terminal',
          workDir: '~/work/api',
          state: 'waiting',
        },
        {
          id: 'w-web',
          name: 'web',
          customName: 'Storefront',
          kind: 'terminal',
          workDir: '~/work/web',
          state: 'idle',
        },
      ],
      activeWorkspaceId: 'w-web',
    })
    useLayoutStore.setState({
      byWorkspace: {
        'w-api': { root: api, activePaneId: api.id, zoomedPaneId: null },
        'w-web': { root: web, activePaneId: web.id, zoomedPaneId: null },
      },
    })
  }

  function open(): void {
    act(() => useUIStore.getState().openDashboard())
  }

  it('draws nothing until it is opened', () => {
    seed()
    render(<DashboardPanel />)
    expect(screen.queryByRole('region', { name: 'Dashboard' })).toBeNull()
    open()
    expect(screen.getByRole('region', { name: 'Dashboard' })).toBeInTheDocument()
  })

  it('says what would appear when nothing waits and no workspace is open', () => {
    render(<DashboardPanel />)
    open()
    expect(screen.getByRole('region', { name: 'Needs you' })).toHaveTextContent(
      'Nothing is waiting for you. Questions agents ask with pine ask and permission requests appear here.',
    )
    expect(screen.getByRole('region', { name: 'Workspaces' })).toHaveTextContent(
      'No workspaces are open.',
    )
    expect(screen.queryByRole('article')).toBeNull()
    expect(screen.getByRole('button', { name: 'Close dashboard' })).toHaveFocus()
  })

  it('lists questions and permission requests together, oldest first, with their workspace', () => {
    seed()
    useQuestionsStore.setState({
      pending: [question('q-late', 'p-web', 'Ship the storefront?', 30)],
    })
    useApprovalsStore.setState({ pending: [APPROVAL] })
    useQuestionsStore.setState((s) => ({
      pending: [...s.pending, question('q-early', 'p-api', 'Run the migration?', 10)],
    }))
    render(<DashboardPanel />)
    open()

    const needs = screen.getByRole('region', { name: 'Needs you' })
    const cards = within(needs).getAllByRole('listitem')
    expect(cards).toHaveLength(3)
    expect(cards[0]).toHaveTextContent('Run the migration?')
    expect(cards[0]).toHaveTextContent('api')
    expect(cards[0]).toHaveTextContent('~/work/api')
    expect(cards[1]).toHaveTextContent('claude wants to type commands into terminals')
    expect(cards[1]).toHaveTextContent('~/work/api')
    expect(cards[2]).toHaveTextContent('Ship the storefront?')
    expect(cards[2]).toHaveTextContent('Storefront')
    expect(within(needs).getByText('3')).toBeInTheDocument()
  })

  it('answers a permission request through the approvals path', async () => {
    seed()
    useApprovalsStore.setState({ pending: [APPROVAL] })
    render(<DashboardPanel />)
    open()
    const card = screen.getByRole('region', { name: 'Agent permission request' })
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Allow once' }))
    expect(window.pine.approvals.answer).toHaveBeenCalledWith('approval-1', 'once')
    expect(window.pine.questions.answer).not.toHaveBeenCalled()
  })

  it('focuses the first pending question when it opens', () => {
    seed()
    useQuestionsStore.setState({
      pending: [
        question('q-early', 'p-api', 'Run the migration?', 10),
        question('q-late', 'p-web', 'Ship the storefront?', 30),
      ],
    })
    render(<DashboardPanel />)
    open()
    const first = screen.getByRole('article', { name: 'Question from claude' })
    expect(within(first).getAllByRole('radio')[0]).toHaveFocus()
  })

  it('focuses the first question even when an older permission request is listed above it', () => {
    seed()
    useApprovalsStore.setState({ pending: [{ ...APPROVAL, at: 1 }] })
    useQuestionsStore.setState({ pending: [question('q1', 'p-web', 'Ship the storefront?', 30)] })
    render(<DashboardPanel />)
    open()
    const card = screen.getByRole('article', { name: 'Question from zsh' })
    expect(within(card).getAllByRole('radio')[0]).toHaveFocus()
  })

  it('focuses a permission request when it is all that waits', () => {
    seed()
    useApprovalsStore.setState({ pending: [APPROVAL] })
    render(<DashboardPanel />)
    open()
    const card = screen.getByRole('region', { name: 'Agent permission request' })
    expect(card).toContainElement(document.activeElement as HTMLElement)
  })

  it('focuses the question the human asked for from its pane', () => {
    seed()
    useQuestionsStore.setState({
      pending: [
        question('q-early', 'p-api', 'Run the migration?', 10),
        question('q-late', 'p-web', 'Ship the storefront?', 30),
      ],
      focusId: 'q-late',
    })
    render(<DashboardPanel />)
    open()
    const late = screen.getByRole('article', { name: 'Question from zsh' })
    expect(within(late).getAllByRole('radio')[0]).toHaveFocus()
    expect(useQuestionsStore.getState().focusId).toBeNull()
  })

  it('shows a question that was just answered as sent, then updates live when it leaves', () => {
    seed()
    const q = question('q1', 'p-api', 'Run the migration?', 10)
    useQuestionsStore.setState({ pending: [], sent: [q] })
    render(<DashboardPanel />)
    open()
    expect(screen.getByRole('status')).toHaveTextContent('Sent to the agent')
    act(() => useQuestionsStore.setState({ sent: [] }))
    expect(screen.queryByRole('article')).toBeNull()
    expect(screen.getByRole('region', { name: 'Needs you' })).toHaveTextContent(
      'Nothing is waiting for you.',
    )
  })

  it('shows each workspace with its name, folder, state and latest message', () => {
    seed()
    useAttentionStore.getState().dispatch('p-api', {
      type: 'set',
      state: 'waiting',
      message: 'Approve the migration plan',
      at: 5,
    })
    render(<DashboardPanel />)
    open()
    const list = screen.getByRole('region', { name: 'Workspaces' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('api')
    expect(rows[0]).toHaveTextContent('Waiting for input')
    expect(rows[0]).toHaveTextContent('~/work/api')
    expect(rows[0]).toHaveTextContent('Approve the migration plan')
    expect(rows[1]).toHaveTextContent('Storefront')
    expect(rows[1]).toHaveTextContent('Idle')
    expect(rows[1]).toHaveTextContent('~/work/web')
  })

  it('shows the running command when no message is waiting', () => {
    seed()
    useBlocksStore.setState({ running: { 'p-web': 'b1' } })
    render(<DashboardPanel />)
    open()
    const row = screen.getByRole('button', { name: 'Open workspace Storefront' }).closest('li')
    expect(row).toHaveTextContent('zsh')
  })

  it('marks a workspace read from its row', async () => {
    seed()
    useAttentionStore.getState().dispatch('p-api', {
      type: 'notify',
      message: 'build finished',
      waiting: false,
      at: 5,
    })
    render(<DashboardPanel />)
    open()
    const list = screen.getByRole('region', { name: 'Workspaces' })
    expect(within(list).getByRole('img', { name: '1 unread' })).toBeInTheDocument()
    await userEvent.setup().click(within(list).getByRole('button', { name: 'Mark as read' }))
    expect(useAttentionStore.getState().byPane['p-api']?.unread).toBe(false)
    expect(within(list).queryByRole('button', { name: 'Mark as read' })).toBeNull()
  })

  it('goes to a workspace when its name is clicked', async () => {
    seed()
    render(<DashboardPanel />)
    open()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open workspace api' }))
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('w-api')
    expect(useUIStore.getState().dashboardActive).toBe(false)
    expect(screen.queryByRole('region', { name: 'Dashboard' })).toBeNull()
  })

  it('shows extension status chips for every workspace, not only the active one', () => {
    seed()
    const chip = (workspaceId: string, text: string): WorkspaceChip => ({
      extId: 'git',
      id: 'branch',
      workspaceId,
      text,
      tone: 'neutral',
    })
    useExtensionsStore.setState({
      list: [git],
      workspaceChips: [chip('w-api', 'feat/refunds'), chip('w-web', 'main')],
    })
    render(<DashboardPanel />)
    open()
    const rows = within(screen.getByRole('region', { name: 'Workspaces' })).getAllByRole('listitem')
    const chips = screen.getAllByRole('list', { name: 'Workspace status' })
    expect(chips).toHaveLength(2)
    expect(rows[0]).toContainElement(chips[0])
    expect(chips[0]).toHaveTextContent('feat/refunds')
    expect(chips[1]).toHaveTextContent('main')
  })

  it('lists the agents a workspace runs and offers to message them, only where one runs', async () => {
    seed()
    const term = { paste: vi.fn() }
    offTerminals.push(registerTerminal('p-api', term as unknown as Terminal))
    useBlocksStore.setState({
      running: { 'p-api': 'b1' },
      agentBlocks: { 'p-api': { blockId: 'b1', agent: 'claude' } },
    })
    render(<DashboardPanel />)
    open()
    const user = userEvent.setup()
    const agents = screen.getByRole('list', { name: 'Agents' })
    expect(within(agents).getAllByRole('button')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Message an agent' })).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Message an agent' }))
    const composer = screen.getByRole('region', { name: 'Message an agent' })
    await user.type(within(composer).getByLabelText('Message'), 'continue')
    await user.click(within(composer).getByRole('button', { name: 'Send' }))
    expect(term.paste).toHaveBeenCalledWith('continue')
    await waitFor(() => expect(window.pine.pty.write).toHaveBeenCalledWith('p-api', '\r'))

    await user.click(within(agents).getByRole('button'))
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('w-api')
    expect(useUIStore.getState().dashboardActive).toBe(false)
  })

  it('lists workspaces that live in another window and focuses that window on click', async () => {
    seed()
    useWindowsStore.setState({
      windowId: '1',
      list: [
        { windowId: '1', detached: false, workspaces: [] },
        {
          windowId: '2',
          detached: true,
          workspaces: [
            {
              id: 'w-far',
              name: 'infra',
              workDir: '~/work/infra',
              state: 'working',
              unreadAt: 0,
              panes: [],
            },
          ],
        },
      ],
    })
    render(<DashboardPanel />)
    open()
    const row = screen.getByRole('button', { name: 'Open workspace infra' }).closest('li')
    expect(row).toHaveTextContent('In another window')
    expect(row).toHaveTextContent('Working')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open workspace infra' }))
    expect(window.pine.windows.focusWorkspace).toHaveBeenCalledWith('w-far', false)
  })

  it('closes on Escape and from its close button', async () => {
    seed()
    render(<DashboardPanel />)
    open()
    const user = userEvent.setup()
    await user.keyboard('{Escape}')
    expect(useUIStore.getState().dashboardActive).toBe(false)
    open()
    await user.click(screen.getByRole('button', { name: 'Close dashboard' }))
    expect(useUIStore.getState().dashboardActive).toBe(false)
  })
})

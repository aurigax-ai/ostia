import type { PaneWhere } from '@/lib/sidebar/dashboard'
import { useLayoutStore } from '@/stores/layoutStore'
import { useQuestionsStore } from '@/stores/questionsStore'
import { useUIStore } from '@/stores/uiStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import type { QuestionRequest } from '@shared/questions'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { QuestionCard } from './QuestionCard'

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0)

const WHERE: PaneWhere = {
  workspaceId: 'w1',
  workspace: 'payments',
  path: '/home/u/work/company/services/payments-api',
  shortPath: '/…/services/payments-api',
  pane: 'Claude · refunds',
}

function question(over: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: 'question-1',
    paneId: 'p1',
    question: 'Which database should the migration target?',
    context: 'Adding the refunds table.',
    choices: [],
    mode: 'text',
    at: NOW - 3 * 60_000,
    ...over,
  }
}

const SINGLE = question({ choices: ['staging', 'production'], mode: 'single' })
const MULTI = question({ choices: ['lint', 'unit', 'e2e'], mode: 'multi' })

describe('QuestionCard', () => {
  let questionsInit: ReturnType<typeof useQuestionsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>

  beforeAll(() => {
    questionsInit = useQuestionsStore.getState()
    uiInit = useUIStore.getState()
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    useQuestionsStore.setState(questionsInit, true)
    useUIStore.setState(uiInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
  })

  function show(q: QuestionRequest, where: PaneWhere | null = WHERE): void {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    useQuestionsStore.setState({ pending: [q] })
    render(<QuestionCard question={q} where={where} />)
  }

  it('names the workspace, its folder, the pane, how long ago, the question and the context', async () => {
    show(question())
    const card = screen.getByRole('article', { name: 'Question from Claude · refunds' })
    expect(within(card).getByText('payments')).toBeInTheDocument()
    expect(within(card).getByText('Claude · refunds')).toBeInTheDocument()
    expect(within(card).getByText('3 min. ago')).toBeInTheDocument()
    expect(
      within(card).getByRole('heading', { name: 'Which database should the migration target?' }),
    ).toBeInTheDocument()
    expect(within(card).getByLabelText('Context')).toHaveTextContent('Adding the refunds table.')

    await userEvent.setup().hover(within(card).getByText('/…/services/payments-api'))
    expect(
      await screen.findByText('/home/u/work/company/services/payments-api', {}, { timeout: 3000 }),
    ).toBeInTheDocument()
  })

  it('takes a free-text reply and sends it only once something is typed', async () => {
    const user = userEvent.setup()
    show(question())
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()

    await user.type(screen.getByLabelText('Reply'), 'staging, prod has no window yet')
    expect(send).toBeEnabled()
    await user.click(send)
    expect(window.ostia.questions.answer).toHaveBeenCalledWith('question-1', {
      choices: [],
      text: 'staging, prod has no window yet',
    })
  })

  it('offers one choice as radios and always a comment box beside them', async () => {
    const user = userEvent.setup()
    show(SINGLE)
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    const comment = screen.getByLabelText('Comment or reply')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    await user.click(screen.getByRole('radio', { name: 'staging' }))
    await user.click(screen.getByRole('radio', { name: 'production' }))
    await user.type(comment, 'after the backup')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(window.ostia.questions.answer).toHaveBeenCalledWith('question-1', {
      choices: [1],
      text: 'after the backup',
    })
  })

  it('lets the human reply instead of choosing, also after clearing a choice', async () => {
    const user = userEvent.setup()
    show(SINGLE)
    await user.click(screen.getByRole('radio', { name: 'staging' }))
    await user.click(screen.getByRole('button', { name: 'Clear choice' }))
    expect(screen.queryByRole('button', { name: 'Clear choice' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    await user.type(screen.getByLabelText('Comment or reply'), 'neither, use the replica')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(window.ostia.questions.answer).toHaveBeenCalledWith('question-1', {
      choices: [],
      text: 'neither, use the replica',
    })
  })

  it('offers several choices as checkboxes and sends them in the order asked', async () => {
    const user = userEvent.setup()
    show(MULTI)
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)
    expect(screen.getByLabelText('Comment or reply')).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'e2e' }))
    await user.click(screen.getByRole('checkbox', { name: 'lint' }))
    await user.click(screen.getByRole('checkbox', { name: 'unit' }))
    await user.click(screen.getByRole('checkbox', { name: 'unit' }))
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(window.ostia.questions.answer).toHaveBeenCalledWith('question-1', {
      choices: [0, 2],
      text: '',
    })
  })

  it('sends with Ctrl+Enter from the reply box', async () => {
    const user = userEvent.setup()
    show(question())
    await user.type(screen.getByLabelText('Reply'), 'go ahead')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(window.ostia.questions.answer).toHaveBeenCalledWith('question-1', {
      choices: [],
      text: 'go ahead',
    })
  })

  it('dismisses through main without sending an answer', async () => {
    show(SINGLE)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(window.ostia.questions.dismiss).toHaveBeenCalledWith('question-1')
    expect(window.ostia.questions.answer).not.toHaveBeenCalled()
  })

  it('keeps the draft when the dashboard is closed and opened again', async () => {
    const user = userEvent.setup()
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    useQuestionsStore.setState({ pending: [SINGLE] })
    const first = render(<QuestionCard question={SINGLE} where={WHERE} />)
    await user.click(screen.getByRole('radio', { name: 'production' }))
    await user.type(screen.getByLabelText('Comment or reply'), 'draft')
    first.unmount()

    render(<QuestionCard question={SINGLE} where={WHERE} />)
    expect(screen.getByRole('radio', { name: 'production' })).toBeChecked()
    expect(screen.getByLabelText('Comment or reply')).toHaveValue('draft')
  })

  it('folds a long context and opens it on request', async () => {
    const long = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n')
    show(question({ context: long }))
    const context = screen.getByLabelText('Context')
    expect(context).toHaveClass('line-clamp-4')
    const toggle = screen.getByRole('button', { name: 'Show all' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.setup().click(toggle)
    expect(context).not.toHaveClass('line-clamp-4')
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('shows the context as plain text, never as markup', () => {
    show(question({ context: '<img src=x onerror=alert(1)> **bold**' }))
    const context = screen.getByLabelText('Context')
    expect(context.querySelector('img')).toBeNull()
    expect(context).toHaveTextContent('<img src=x onerror=alert(1)> **bold**')
  })

  it('has no fold button for a short context and no context block without one', () => {
    show(question({ context: '' }))
    expect(screen.queryByLabelText('Context')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull()
  })

  it('says when a timed question stops waiting', () => {
    show(question({ expiresAt: NOW + 600_000 }))
    expect(screen.getByText(/^waits until /)).toBeInTheDocument()
  })

  it('shows a sent state in place of the form', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    render(<QuestionCard question={SINGLE} where={WHERE} sent />)
    expect(screen.getByRole('status')).toHaveTextContent('Sent to the agent')
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  })

  it('goes to the asking pane and leaves the dashboard', async () => {
    const { createPane } = await import('@/layout/tree')
    const pane = { ...createPane('terminal'), id: 'p1' }
    useWorkspacesStore.setState({
      workspaces: [{ id: 'w1', name: 'payments', kind: 'terminal', workDir: '/p', state: 'idle' }],
      activeWorkspaceId: null,
    })
    useLayoutStore.setState({
      byWorkspace: { w1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })
    useUIStore.getState().openDashboard()
    show(SINGLE)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Go to pane' }))
    await waitFor(() => expect(useUIStore.getState().dashboardActive).toBe(false))
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('w1')
  })

  it('still lets the human answer a question whose pane this window cannot find', () => {
    show(SINGLE, null)
    expect(screen.getByRole('article', { name: 'Question from Closed pane' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Go to pane' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })

  describe('a permission request', () => {
    const PERMISSION = question({
      question: 'Bash: rm -rf node_modules',
      context: 'rm -rf node_modules',
      choices: ['once', 'always', 'deny'],
      mode: 'single',
      permission: { agent: 'claude', tool: 'Bash' },
    })

    it('names the agent and the tool, shows its input and offers the allow and deny buttons', () => {
      show(PERMISSION)
      expect(
        screen.getByRole('heading', { name: 'Claude Code asks to use Bash' }),
      ).toBeInTheDocument()
      expect(screen.getByLabelText('Context')).toHaveTextContent('rm -rf node_modules')
      expect(screen.queryByLabelText('Comment or reply')).toBeNull()
      expect(screen.queryByRole('radio')).toBeNull()
      for (const name of ['Allow once', 'Always allow', 'Deny', 'Answer in terminal']) {
        expect(screen.getByRole('button', { name })).toBeInTheDocument()
      }
    })

    it('answers with the picked choice', async () => {
      const user = userEvent.setup()
      show(PERMISSION)
      await user.click(screen.getByRole('button', { name: 'Deny' }))
      expect(window.ostia.questions.answer).toHaveBeenCalledWith('question-1', {
        choices: [2],
        text: '',
      })
    })

    it('hands the request back to the agent’s own prompt from Answer in terminal', async () => {
      const user = userEvent.setup()
      show(PERMISSION)
      await user.click(screen.getByRole('button', { name: 'Answer in terminal' }))
      expect(window.ostia.questions.dismiss).toHaveBeenCalledWith('question-1')
      expect(window.ostia.questions.answer).not.toHaveBeenCalled()
    })
  })
})

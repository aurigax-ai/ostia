import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QUESTIONS_PER_PANE,
  QUESTION_RATE_LIMIT,
  QUESTION_RATE_WINDOW_MS,
  type QuestionOutcome,
  type QuestionState,
} from '../../shared/questions'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  webContents: { fromId: vi.fn() },
}))
vi.mock('../control/controlServer', () => ({ registerControlMethod: vi.fn() }))

const { createQuestions } = await import('./questions')

const ASK = {
  externalId: 'ext-1',
  windowId: '7',
  paneId: 'p1',
  question: 'Which database?',
  context: 'Adding the refunds table',
  choices: ['staging', 'production'],
  mode: 'single' as const,
}

function setup(windowOpen = true) {
  const published: { windowId: string; state: QuestionState }[] = []
  let now = 1000
  const questions = createQuestions({
    publish: (windowId, state) => {
      published.push({ windowId, state })
      return windowOpen
    },
    now: () => now,
  })
  const ask = (over: Partial<typeof ASK> & { timeoutMs?: number } = {}) => {
    const ticket = questions.ask({ ...ASK, ...over })
    if (!ticket.ok) throw new Error(ticket.error)
    return ticket
  }
  return {
    questions,
    published,
    ask,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('questions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('publishes an open question to the window that owns the pane, and to no other', () => {
    const { questions, published, ask } = setup()
    ask()
    expect(published.at(-1)).toMatchObject({ windowId: '7' })
    expect(questions.stateFor('7').pending).toEqual([
      {
        id: 'question-1',
        paneId: 'p1',
        question: 'Which database?',
        context: 'Adding the refunds table',
        choices: ['staging', 'production'],
        mode: 'single',
        at: 1000,
      },
    ])
    expect(questions.stateFor('8').pending).toEqual([])
  })

  it('resolves with the chosen labels and the reply once the owning window answers', async () => {
    const { questions, ask } = setup()
    const ticket = ask()
    expect(questions.answer('7', ticket.id, { choices: [1], text: 'after the backup' })).toBe(true)
    await expect(ticket.outcome).resolves.toEqual({
      outcome: 'answered',
      choices: ['production'],
      text: 'after the backup',
    })
    expect(questions.stateFor('7').pending).toEqual([])
  })

  it('ignores an answer or a dismissal from a window that does not own the question', () => {
    const { questions, ask } = setup()
    const ticket = ask()
    expect(questions.answer('8', ticket.id, { choices: [0], text: '' })).toBe(false)
    expect(questions.dismiss('8', ticket.id)).toBe(false)
    expect(questions.stateFor('7').pending).toHaveLength(1)
  })

  it('refuses an answer that does not fit the question and keeps it open', () => {
    const { questions, ask } = setup()
    const ticket = ask()
    expect(questions.answer('7', ticket.id, { choices: [0, 1], text: '' })).toBe(false)
    expect(questions.answer('7', ticket.id, { choices: [], text: '' })).toBe(false)
    expect(questions.answer('7', 'question-99', { choices: [0], text: '' })).toBe(false)
    expect(questions.stateFor('7').pending).toHaveLength(1)
  })

  it('resolves as dismissed when the human dismisses it', async () => {
    const { questions, ask } = setup()
    const ticket = ask()
    expect(questions.dismiss('7', ticket.id)).toBe(true)
    await expect(ticket.outcome).resolves.toEqual({ outcome: 'dismissed' })
    expect(questions.dismiss('7', ticket.id)).toBe(false)
  })

  it('times out only when the caller set a timeout', async () => {
    const { questions, ask } = setup()
    const forever = ask()
    const timed = ask({ timeoutMs: 5000 })
    expect(questions.stateFor('7').pending[1]).toMatchObject({ expiresAt: 6000 })
    vi.advanceTimersByTime(5000)
    await expect(timed.outcome).resolves.toEqual({ outcome: 'timeout' })
    expect(questions.stateFor('7').pending.map((q) => q.id)).toEqual([forever.id])
  })

  it('drops every question of a pane that closed', async () => {
    const { questions, ask, published } = setup()
    const mine = ask()
    const other = ask({ externalId: 'ext-2', paneId: 'p2' })
    questions.forget('ext-1')
    await expect(mine.outcome).resolves.toEqual({ outcome: 'closed' })
    expect(questions.stateFor('7').pending.map((q) => q.id)).toEqual([other.id])
    expect(published.at(-1)?.state.pending).toHaveLength(1)
  })

  it('withdraws a question when the asking command ends', async () => {
    const { questions, ask } = setup()
    const ticket = ask()
    questions.withdraw(ticket.id)
    await expect(ticket.outcome).resolves.toEqual({ outcome: 'closed' })
    expect(questions.answer('7', ticket.id, { choices: [0], text: '' })).toBe(false)
  })

  it('ends at once when the pane has no window to show it in', async () => {
    const { ask } = setup(false)
    await expect(ask().outcome).resolves.toEqual({ outcome: 'closed' })
  })

  it('moves open questions with their pane to another window', () => {
    const { questions, ask, published } = setup()
    const ticket = ask()
    published.length = 0
    questions.rehome(['ext-1'], '9')
    expect(published.map((p) => p.windowId).sort()).toEqual(['7', '9'])
    expect(questions.stateFor('7').pending).toEqual([])
    expect(questions.stateFor('9').pending.map((q) => q.id)).toEqual([ticket.id])
    expect(questions.answer('7', ticket.id, { choices: [0], text: '' })).toBe(false)
    expect(questions.answer('9', ticket.id, { choices: [0], text: '' })).toBe(true)
  })

  it('publishes nothing when a move changes no window', () => {
    const { questions, ask, published } = setup()
    ask()
    published.length = 0
    questions.rehome(['ext-1'], '7')
    questions.rehome(['ext-unknown'], '9')
    expect(published).toEqual([])
  })

  it('caps the open questions of one pane and frees a slot when one ends', () => {
    const { questions, ask } = setup()
    const tickets = Array.from({ length: QUESTIONS_PER_PANE }, () => ask())
    expect(questions.ask(ASK)).toMatchObject({ ok: false, error: 'too-many-questions' })
    expect(questions.ask({ ...ASK, externalId: 'ext-2', paneId: 'p2' }).ok).toBe(true)
    questions.dismiss('7', tickets[0].id)
    expect(questions.ask(ASK).ok).toBe(true)
  })

  it('rate-limits a pane that keeps asking and lets it ask again after the window', () => {
    const { questions, ask, advance } = setup()
    for (let i = 0; i < QUESTION_RATE_LIMIT; i++) questions.dismiss('7', ask().id)
    expect(questions.ask(ASK)).toMatchObject({ ok: false, error: 'rate-limited' })
    expect(questions.stateFor('7').pending).toEqual([])
    advance(QUESTION_RATE_WINDOW_MS)
    expect(questions.ask(ASK).ok).toBe(true)
  })

  it('lists the oldest question first', () => {
    const { questions, ask, advance } = setup()
    const first = ask()
    advance(10)
    const second = ask({ externalId: 'ext-2', paneId: 'p2' })
    expect(questions.stateFor('7').pending.map((q) => q.id)).toEqual([first.id, second.id])
  })

  it('settles each question once', async () => {
    const { questions, ask } = setup()
    const ticket = ask({ timeoutMs: 1000 })
    questions.answer('7', ticket.id, { choices: [0], text: '' })
    vi.advanceTimersByTime(2000)
    questions.forget('ext-1')
    const outcome: QuestionOutcome = await ticket.outcome
    expect(outcome).toEqual({ outcome: 'answered', choices: ['staging'], text: '' })
  })
})

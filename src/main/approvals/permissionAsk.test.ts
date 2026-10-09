import { afterEach, describe, expect, it, vi } from 'vitest'
import { PERMISSION_WAIT_MS } from '../../shared/agents/agentPermissions'
import type { QuestionRequest } from '../../shared/agents/questions'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  webContents: { fromId: vi.fn() },
}))
vi.mock('../control/controlServer', () => ({ registerControlMethod: vi.fn() }))

const { createQuestions } = await import('./questions')
const { askPermission } = await import('./permissionAsk')

const PARAMS = { agent: 'claude', tool: 'Bash', detail: 'npm test', always: false }

function setup(phoneCanAnswer = true) {
  const opened: QuestionRequest[] = []
  const questions = createQuestions({
    publish: () => true,
    now: () => 1000,
    opened: (request) => opened.push(request),
  })
  let closeHook = (): void => {}
  const ctx = {
    identity: { externalId: 'ext-1', windowId: '7', paneId: 'p1' },
    conn: {
      onClose: (cb: () => void) => {
        closeHook = cb
        return { dispose: () => {} }
      },
    },
  } as unknown as Parameters<typeof askPermission>[1]
  const ask = (params: unknown = PARAMS) =>
    askPermission(params, ctx, { questions: () => questions, phoneCanAnswer: () => phoneCanAnswer })
  return { questions, opened, ask, closeHook: () => closeHook() }
}

describe('askPermission', () => {
  afterEach(() => vi.useRealTimers())

  it('returns at once with no decision while no phone can answer, so the agent prompts as before', async () => {
    const t = setup(false)
    expect(await t.ask()).toEqual({ decision: null })
    expect(t.opened).toEqual([])
  })

  it('asks the desktop and phones with the tool, its input and the offered choices', async () => {
    const t = setup()
    void t.ask()
    expect(t.opened).toMatchObject([
      {
        question: 'Bash: npm test',
        context: 'npm test',
        choices: ['once', 'deny'],
        mode: 'single',
        permission: { agent: 'claude', tool: 'Bash' },
      },
    ])
  })

  it('returns the decision the human picked', async () => {
    const t = setup()
    const decision = t.ask()
    const [request] = t.opened
    t.questions.answer('7', request?.id ?? '', { choices: [1], text: '' })
    expect(await decision).toEqual({ decision: 'deny' })
  })

  it('falls back to the agent’s own prompt when the human answers in the terminal', async () => {
    const t = setup()
    const decision = t.ask()
    t.questions.dismiss('7', t.opened[0]?.id ?? '')
    expect(await decision).toEqual({ decision: null })
  })

  it('falls back to the agent’s own prompt when nobody answers in time', async () => {
    vi.useFakeTimers()
    const t = setup()
    const decision = t.ask()
    vi.advanceTimersByTime(PERMISSION_WAIT_MS)
    expect(await decision).toEqual({ decision: null })
    expect(t.questions.open()).toEqual([])
  })

  it('withdraws the ask when the agent stops waiting for its hook', async () => {
    const t = setup()
    const decision = t.ask()
    t.closeHook()
    expect(await decision).toEqual({ decision: null })
    expect(t.questions.open()).toEqual([])
  })

  it('never takes a free-text reply as a decision', async () => {
    const t = setup()
    void t.ask()
    expect(t.questions.answer('7', t.opened[0]?.id ?? '', { choices: [], text: 'yes' })).toBe(false)
  })

  it('refuses an unknown agent without asking', async () => {
    const t = setup()
    expect(await t.ask({ ...PARAMS, agent: 'gemini' })).toEqual({ decision: null })
    expect(t.opened).toEqual([])
  })
})

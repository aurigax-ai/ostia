import { type ChildProcess, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuestionRequest, QuestionState } from '../shared/questions'
import type { CommandResult } from '../shared/types'

const WINDOW_ID = '7'
const sent: { channel: string; state: QuestionState }[] = []

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  webContents: {
    fromId: (id: number) =>
      String(id) === WINDOW_ID
        ? {
            isDestroyed: () => false,
            send: (channel: string, state: QuestionState) => sent.push({ channel, state }),
          }
        : undefined,
  },
}))

const { registerControlServer, stopControlServer } = await import('../main/controlServer')
const { registerPane, removePane } = await import('../main/idRegistry')
const { questions, registerQuestions } = await import('../main/questions')

registerQuestions()

const cliPath = join(process.cwd(), 'out', 'cli', 'index.js')
const agent = registerPane({ windowId: WINDOW_ID, workspaceId: 'ws1', paneId: 'agent-pane' })

interface Running {
  child: ChildProcess
  done: Promise<{ code: number | null; stdout: string; stderr: string }>
}

let socketPath = ''
let seq = 0
const live = new Set<ChildProcess>()

function pine(args: string[], stdin?: string, token = agent.token): Running {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: { ...process.env, PINE_SOCKET: socketPath, PINE_TOKEN: token },
    stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  live.add(child)
  child.stdin?.on('error', () => {})
  if (stdin !== undefined) child.stdin?.end(stdin)
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('close', (code) => {
      live.delete(child)
      resolve({ code, stdout, stderr })
    })
  })
  return { child, done }
}

function pending(): QuestionRequest[] {
  return questions()?.stateFor(WINDOW_ID).pending ?? []
}

async function nextQuestion(count = 1): Promise<QuestionRequest> {
  await vi.waitFor(() => expect(pending()).toHaveLength(count), { timeout: 10_000 })
  return pending()[count - 1] as QuestionRequest
}

beforeEach(() => {
  seq += 1
  socketPath = join(tmpdir(), `pine-cli-ask-${process.pid}-${seq}.sock`)
  registerControlServer(
    {
      execCommand: async () => ({ ok: true }) as CommandResult,
      listCommandsFor: () => [],
      getTerminalState: () => undefined,
    },
    socketPath,
  )
  sent.length = 0
})

afterEach(async () => {
  for (const child of live) child.kill('SIGKILL')
  questions()?.forget(agent.externalId)
  stopControlServer()
})

afterAll(() => {
  removePane(agent.paneId)
})

describe('ostia ask (the real CLI against a live control server)', () => {
  it('blocks until the human answers, then prints the chosen label and the comment', async () => {
    const run = pine([
      'ask',
      'Which database?',
      '--context',
      'Adding the refunds table',
      '--choice',
      'staging',
      '--choice',
      'production',
    ])
    const question = await nextQuestion()
    expect(question).toMatchObject({
      paneId: 'agent-pane',
      question: 'Which database?',
      context: 'Adding the refunds table',
      choices: ['staging', 'production'],
      mode: 'single',
    })
    expect(sent.at(-1)).toMatchObject({ channel: 'questions:changed' })
    expect(run.child.exitCode).toBeNull()

    expect(questions()?.answer(WINDOW_ID, question.id, { choices: [1], text: 'after 02:00' })).toBe(
      true,
    )
    const res = await run.done
    expect(res).toEqual({ code: 0, stdout: 'production\nafter 02:00\n', stderr: '' })
    expect(pending()).toEqual([])
  })

  it('prints several choices as JSON for --multi --json', async () => {
    const run = pine([
      'ask',
      'Which checks?',
      '--choice',
      'lint',
      '--choice',
      'unit',
      '--multi',
      '--json',
    ])
    const question = await nextQuestion()
    expect(question.mode).toBe('multi')
    questions()?.answer(WINDOW_ID, question.id, { choices: [1, 0], text: '' })
    const res = await run.done
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout)).toEqual({ answered: true, choices: ['lint', 'unit'], text: '' })
  })

  it('reads the context from stdin only for --context -', async () => {
    const run = pine(['ask', 'Ship this?', '--context', '-'], ' 3 files changed\n 40 insertions\n')
    const question = await nextQuestion()
    expect(question.context).toBe('3 files changed\n 40 insertions')
    expect(question.mode).toBe('text')
    questions()?.answer(WINDOW_ID, question.id, { choices: [], text: 'ship it' })
    expect((await run.done).stdout).toBe('ship it\n')
  })

  it('does not wait on an open stdin without --context -', async () => {
    const child = spawn(process.execPath, [cliPath, 'ask', 'Still there?'], {
      env: { ...process.env, PINE_SOCKET: socketPath, PINE_TOKEN: agent.token },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    live.add(child)
    const question = await nextQuestion()
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve))
    questions()?.answer(WINDOW_ID, question.id, { choices: [], text: 'yes' })
    expect(await closed).toBe(0)
    live.delete(child)
  })

  it('exits 2 with a line on stderr when the human dismisses it', async () => {
    const run = pine(['ask', 'Continue?'])
    const question = await nextQuestion()
    questions()?.dismiss(WINDOW_ID, question.id)
    const res = await run.done
    expect(res.code).toBe(2)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('ostia ask: dismissed by the human without an answer\n')
  })

  it('exits 3 when its timeout passes unanswered', async () => {
    const res = await pine(['ask', 'Continue?', '--timeout', '1', '--json']).done
    expect(res.code).toBe(3)
    expect(JSON.parse(res.stdout)).toEqual({ answered: false, reason: 'timeout' })
    expect(res.stderr).toMatch(/timed out/)
    expect(pending()).toEqual([])
  })

  it('exits 4 when the pane closes while it waits', async () => {
    const doomed = registerPane({ windowId: WINDOW_ID, workspaceId: 'ws1', paneId: 'doomed-pane' })
    const run = pine(['ask', 'Continue?'], undefined, doomed.token)
    await nextQuestion()
    questions()?.forget(doomed.externalId)
    removePane(doomed.paneId)
    const res = await run.done
    expect(res.code).toBe(4)
    expect(res.stderr).toMatch(/pane closed/)
  })

  it('withdraws the question when the asking command is stopped', async () => {
    const run = pine(['ask', 'Continue?'])
    await nextQuestion()
    run.child.kill('SIGTERM')
    await run.done
    await vi.waitFor(() => expect(pending()).toEqual([]), { timeout: 10_000 })
    expect(sent.at(-1)?.state.pending).toEqual([])
  })

  it('refuses a fourth open question from one pane with exit 1', async () => {
    pine(['ask', 'one?'])
    await nextQuestion(1)
    pine(['ask', 'two?'])
    await nextQuestion(2)
    pine(['ask', 'three?'])
    await nextQuestion(3)
    const res = await pine(['ask', 'four?']).done
    expect(res.code).toBe(1)
    expect(res.stderr).toMatch(/^ostia ask: too-many-questions/)
    expect(pending()).toHaveLength(3)
  })

  it('refuses bad arguments without asking anything', async () => {
    const res = await pine(['ask', 'Pick', '--multi']).done
    expect(res.code).toBe(1)
    expect(res.stderr).toMatch(/--multi needs at least one --choice/)
    expect(pending()).toEqual([])
  })

  it('has no verb or socket method that answers or dismisses a question', async () => {
    const run = pine(['ask', 'Continue?'])
    const question = await nextQuestion()
    for (const method of ['question.answer', 'question.dismiss', 'questions.answer']) {
      const res = await pine([method, JSON.stringify({ id: question.id, text: 'yes' })]).done
      expect(res.code).toBe(1)
    }
    expect(pending()).toHaveLength(1)
    questions()?.dismiss(WINDOW_ID, question.id)
    await run.done
  })
})

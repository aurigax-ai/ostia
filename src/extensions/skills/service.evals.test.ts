import type { ExtensionCaller, ExtensionResult } from '@aurigax-ai/ostia-extension-sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppliedStore } from './appliedStore'
import type { EvalCase, EvalRun } from './evalCase'
import { EvalStore } from './evalStore'
import type { Complete } from './extract'
import { skillsService } from './service'
import { SignalStore } from './signalStore'
import { RulesStore } from './store'

const caller = {
  kind: 'pane',
  paneId: 'p1',
  workspaceId: 'w1',
  workDir: '/w',
  cwd: '/w',
  capabilities: [],
} as ExtensionCaller
const good = {
  rule: 'r1',
  prompt: 'Add a retry helper.',
  files: [{ path: 'src/http.ts', content: 'export const get = () => 1' }],
  check: { kind: 'absent', value: '//' },
}

interface Board {
  cases: EvalCase[]
  runs: EvalRun[]
  running: { rule: string; done: number; total: number } | null
  failed: { rule: string; error: string } | null
}

describe('test cases and runs in the service', () => {
  let store: RulesStore
  let evals: EvalStore
  let service: ReturnType<typeof skillsService>
  let complete: Complete
  let redactFails: boolean
  let secret: string

  beforeEach(() => {
    store = new RulesStore(null, () => 1000)
    evals = new EvalStore(null)
    redactFails = false
    secret = ''
    complete = async () => ({ ok: false, error: 'no-model' })
    service = skillsService({
      store,
      signals: new SignalStore(null, () => 1000),
      applied: new AppliedStore(null, () => 1000),
      evals,
      complete: (system, input) => complete(system, input),
      now: () => 1000,
      holdout: () => false,
      random: () => 0.5,
      redact: async (texts) =>
        redactFails ? null : texts.map((t) => (secret && t.includes(secret) ? '[redacted]' : t)),
      confirmDelete: async () => true,
      workspace: async () => ({ kind: 'terminal', workDir: '/w' }),
      folderScopeOf: async () => ({ projectKeys: ['p'], stacks: [] }),
      changed: () => {},
    })
    store.add({ rule: 'Write no comments.', why: '', when: '', scope: 'global' }, 'human')
  })

  const board = async (): Promise<Board> =>
    ((await service.panel.scoreboard({}, caller)) as ExtensionResult & { data: { evals: Board } })
      .data.evals
  const settled = async (): Promise<Board> => {
    for (let i = 0; i < 200; i++) {
      const b = await board()
      if (!b.running) return b
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('the test did not finish')
  }

  it('saves a case the human wrote, as accepted', async () => {
    expect((await service.panel['save-case'](good, caller)).ok).toBe(true)
    expect((await board()).cases).toMatchObject([{ rule: 'r1', origin: 'human', accepted: true }])
  })

  it.each([
    ['an unknown rule', { ...good, rule: 'r9' }, 'not-found'],
    ['a broken pattern', { ...good, check: { kind: 'matches', value: '(' } }, 'invalid-args'],
    ['a command check', { ...good, check: { kind: 'command', value: 'make' } }, 'invalid-args'],
    ['no task', { ...good, prompt: '' }, 'invalid-args'],
  ])('refuses %s', async (_n, input, error) => {
    expect(await service.panel['save-case'](input, caller)).toMatchObject({ ok: false, error })
    expect((await board()).cases).toEqual([])
  })

  it('stores no text when it holds a secret or the scan fails', async () => {
    secret = 'sk-live'
    expect(
      await service.panel['save-case']({ ...good, prompt: 'Use sk-live now.' }, caller),
    ).toMatchObject({ ok: false, error: 'refused' })
    redactFails = true
    expect(await service.panel['save-case'](good, caller)).toMatchObject({
      ok: false,
      error: 'redact-failed',
    })
    expect((await board()).cases).toEqual([])
  })

  it('allows five cases for a rule and no more', async () => {
    for (let i = 0; i < 5; i++) await service.panel['save-case'](good, caller)
    expect(await service.panel['save-case'](good, caller)).toMatchObject({
      ok: false,
      error: 'too-many',
    })
  })

  describe('drafts', () => {
    const reply = (cases: unknown[]) => async () => ({
      ok: true as const,
      text: JSON.stringify({ cases }),
    })

    it('adds the model’s cases as waiting, and a run ignores them until the human accepts', async () => {
      complete = reply([good, good])
      expect(await service.panel['draft-cases']({ rule: 'r1' }, caller)).toMatchObject({
        ok: true,
        data: { added: 2 },
      })
      expect((await board()).cases.map((c) => [c.origin, c.accepted])).toEqual([
        ['model', false],
        ['model', false],
      ])
      expect(await service.panel['run-eval']({ rule: 'r1' }, caller)).toMatchObject({
        ok: false,
        error: 'no-cases',
      })
      await service.panel['accept-case']({ id: 'c1' }, caller)
      expect((await board()).cases.map((c) => c.accepted)).toEqual([true, false])
    })

    it('keeps only valid drafts, skips ones with a secret, and fills no more than the room', async () => {
      secret = 'sk-live'
      complete = reply([good, { ...good, prompt: 'Use sk-live.' }, good, good])
      await service.panel['draft-cases']({ rule: 'r1' }, caller)
      expect((await board()).cases).toHaveLength(2)
      for (let i = 0; i < 2; i++) await service.panel['save-case'](good, caller)
      complete = reply([good, good, good])
      await service.panel['draft-cases']({ rule: 'r1' }, caller)
      expect((await board()).cases).toHaveLength(5)
      expect(await service.panel['draft-cases']({ rule: 'r1' }, caller)).toMatchObject({
        ok: false,
        error: 'too-many',
      })
    })

    it('passes the model error on', async () => {
      expect(await service.panel['draft-cases']({ rule: 'r1' }, caller)).toMatchObject({
        ok: false,
        error: 'no-model',
      })
      expect(await service.panel['draft-cases']({ rule: 'r9' }, caller)).toMatchObject({
        ok: false,
        error: 'not-found',
      })
    })
  })

  describe('run-eval', () => {
    beforeEach(async () => {
      await service.panel['save-case'](good, caller)
    })

    it('runs the paired calls in the background and keeps the result', async () => {
      complete = async (system) => ({
        ok: true,
        text: system.includes('[r1]') ? 'const a = 1' : 'const a = 1 // one',
      })
      expect((await service.panel['run-eval']({ rule: 'r1' }, caller)).ok).toBe(true)
      const done = await settled()
      expect(done.runs).toMatchObject([
        { rule: 'r1', pairs: 5, withPass: 5, withoutPass: 0, calls: 10, verdict: 'helps' },
      ])
      expect(done.failed).toBeNull()
    })

    it('reports progress while it runs and refuses a second run', async () => {
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      complete = async () => {
        await gate
        return { ok: true, text: 'x' }
      }
      await service.panel['run-eval']({ rule: 'r1' }, caller)
      expect((await board()).running).toEqual({ rule: 'r1', done: 0, total: 10 })
      expect(await service.panel['run-eval']({ rule: 'r1' }, caller)).toMatchObject({
        ok: false,
        error: 'busy',
      })
      release()
      expect((await settled()).runs).toHaveLength(1)
    })

    it('stores no run and shows the error when the model fails', async () => {
      complete = async () => ({ ok: false, error: 'no-model' })
      await service.panel['run-eval']({ rule: 'r1' }, caller)
      const done = await settled()
      expect(done.runs).toEqual([])
      expect(done.failed).toEqual({ rule: 'r1', error: 'no-model' })
    })

    it('stops on cancel and stores nothing', async () => {
      let calls = 0
      complete = async () => {
        calls += 1
        await service.panel['cancel-eval']({}, caller)
        return { ok: true, text: 'x' }
      }
      await service.panel['run-eval']({ rule: 'r1' }, caller)
      const done = await settled()
      expect(calls).toBe(1)
      expect(done.runs).toEqual([])
      expect(done.failed).toBeNull()
    })

    it('runs only for an active rule', async () => {
      store.setState('r1', 'retired')
      expect(await service.panel['run-eval']({ rule: 'r1' }, caller)).toMatchObject({
        ok: false,
        error: 'not-found',
      })
    })

    it('drops the rule’s cases and runs when the rule is deleted', async () => {
      complete = async () => ({ ok: true, text: 'x' })
      await service.panel['run-eval']({ rule: 'r1' }, caller)
      await settled()
      await service.panel.delete({ id: 'r1' }, caller)
      expect(evals.listCases()).toEqual([])
      expect(evals.listRuns()).toEqual([])
    })
  })

  it('deletes a case', async () => {
    await service.panel['save-case'](good, caller)
    expect((await service.panel['delete-case']({ id: 'c1' }, caller)).ok).toBe(true)
    expect(await service.panel['delete-case']({ id: 'c1' }, caller)).toMatchObject({
      ok: false,
      error: 'not-found',
    })
  })
})

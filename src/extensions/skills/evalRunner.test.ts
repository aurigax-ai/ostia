import { describe, expect, it } from 'vitest'
import { type EvalCase, parseCaseInput } from './evalCase'
import { passes } from './evalCheck'
import { EVAL_SYSTEM, evalInput, evalSystem, PAIRS_PER_CASE, runEval } from './evalRunner'
import type { Rule } from './rule'
import { seeded } from './testRandom'

const rule: Rule = {
  id: 'r1',
  rule: 'Write no comments.',
  why: 'a private reason',
  when: '',
  scope: 'global',
  state: 'active',
  origin: 'human',
  createdAt: 1,
}

const aCase = (extra: Partial<EvalCase> = {}): EvalCase => ({
  id: 'c1',
  rule: 'r1',
  prompt: 'Add a retry helper.',
  files: [{ path: 'src/http.ts', content: 'export const get = () => 1' }],
  check: { kind: 'absent', value: '//' },
  origin: 'human',
  accepted: true,
  ...extra,
})

describe('the eval prompts', () => {
  it('give the rule only in the with-rule arm, and never its reason', () => {
    expect(evalSystem(null)).toBe(EVAL_SYSTEM)
    const withRule = evalSystem(rule)
    expect(withRule).toContain('- Write no comments. [r1]')
    expect(withRule).toContain('preferences, not permissions')
    expect(withRule).not.toContain('a private reason')
  })

  it('show the files and the task', () => {
    expect(evalInput(aCase())).toBe(
      'Files:\n=== src/http.ts\nexport const get = () => 1\n\nTask: Add a retry helper.',
    )
    expect(evalInput(aCase({ files: [] }))).toBe('Task: Add a retry helper.')
  })
})

const three = [aCase(), aCase({ id: 'c2' }), aCase({ id: 'c3' })]

describe('runEval', () => {
  const deps = (reply: (system: string) => string, extra: object = {}) => {
    const sent: { system: string; input: string }[] = []
    let clock = 0
    return {
      sent,
      deps: {
        complete: async (system: string, input: string) => {
          sent.push({ system, input })
          return { ok: true as const, text: reply(system) }
        },
        random: seeded(5),
        now: () => {
          clock += 1000
          return clock
        },
        cancelled: () => false,
        progress: () => {},
        ...extra,
      },
    }
  }

  it('says helps when the rule changes the answer and the interval clears zero', async () => {
    const { deps: d, sent } = deps((system) =>
      system.includes('[r1]') ? 'const a = 1' : 'const a = 1 // one',
    )
    const outcome = await runEval(rule, three, d)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run).toMatchObject({
      rule: 'r1',
      pairs: 3 * PAIRS_PER_CASE,
      withPass: 15,
      withoutPass: 0,
      calls: 30,
      verdict: 'helps',
    })
    expect(outcome.run.low).toBeGreaterThan(0)
    expect(sent.filter((s) => s.system.includes('[r1]'))).toHaveLength(15)
  })

  it('says no clear effect when both arms answer alike', async () => {
    const { deps: d } = deps(() => 'const a = 1')
    const outcome = await runEval(rule, three, d)
    expect(outcome.ok && outcome.run).toMatchObject({
      withPass: 15,
      withoutPass: 15,
      verdict: 'no-clear-effect',
    })
  })

  it('says hurts when the rule makes the answer fail the check', async () => {
    const { deps: d } = deps((system) => (system.includes('[r1]') ? 'a // b' : 'a'))
    const outcome = await runEval(rule, three, d)
    expect(outcome.ok && outcome.run.verdict).toBe('hurts')
  })

  it('gives no verdict from fewer than three cases', async () => {
    const { deps: d, sent } = deps(() => 'x')
    expect(await runEval(rule, [aCase(), aCase({ id: 'c2' })], d)).toEqual({
      ok: false,
      error: 'few-cases',
    })
    expect(sent).toEqual([])
  })

  it('reports each call as progress and stops at the first failure, with nothing stored', async () => {
    const progress: [number, number][] = []
    let calls = 0
    const outcome = await runEval(rule, three, {
      ...deps(() => 'x').deps,
      complete: async () =>
        ++calls === 3 ? { ok: false, error: 'no-model' } : { ok: true, text: 'x' },
      progress: (done, total) => progress.push([done, total]),
    })
    expect(outcome).toEqual({ ok: false, error: 'no-model' })
    expect(progress).toEqual([
      [1, 30],
      [2, 30],
      [3, 30],
    ])
  })

  it('stops when cancelled, before the next call', async () => {
    let cancelled = false
    const { deps: d, sent } = deps(() => 'x')
    const outcome = await runEval(rule, three, {
      ...d,
      cancelled: () => cancelled,
      progress: (done) => {
        if (done === 2) cancelled = true
      },
    })
    expect(outcome).toEqual({ ok: false, error: 'cancelled' })
    expect(sent).toHaveLength(2)
  })

  it('treats a thrown call as a failure', async () => {
    const outcome = await runEval(rule, three, {
      ...deps(() => 'x').deps,
      complete: async () => {
        throw new Error('down')
      },
    })
    expect(outcome).toEqual({ ok: false, error: 'failed' })
  })
})

describe('case input and checks', () => {
  const input = {
    prompt: 'Add a helper.',
    files: [{ path: 'src/a.ts', content: 'x' }],
    check: { kind: 'matches', value: 'helper' },
  }

  it('accepts a good case and trims the prompt', () => {
    expect(parseCaseInput({ ...input, prompt: ' Add a helper. ' })).toEqual(input)
  })

  it.each([
    ['no prompt', { ...input, prompt: ' ' }],
    ['long prompt', { ...input, prompt: 'x'.repeat(2001) }],
    [
      'too many files',
      { ...input, files: Array.from({ length: 6 }, (_, i) => ({ path: `f${i}`, content: '' })) },
    ],
    ['absolute path', { ...input, files: [{ path: '/etc/passwd', content: '' }] }],
    ['dotdot path', { ...input, files: [{ path: 'a/../../b', content: '' }] }],
    ['duplicate path', { ...input, files: [input.files[0], input.files[0]] }],
    ['big file', { ...input, files: [{ path: 'a', content: 'x'.repeat(20_001) }] }],
    ['unknown kind', { ...input, check: { kind: 'command', value: 'make test' } }],
    ['empty pattern', { ...input, check: { kind: 'matches', value: '' } }],
    ['broken pattern', { ...input, check: { kind: 'matches', value: '(' } }],
    ['long pattern', { ...input, check: { kind: 'matches', value: 'a'.repeat(201) } }],
    ['not an object', 'x'],
  ])('refuses %s', (_name, raw) => {
    expect(parseCaseInput(raw)).toBeNull()
  })

  it('checks matches and absent across lines', () => {
    expect(passes({ kind: 'matches', value: '^export ' }, 'a\nexport const x')).toBe(true)
    expect(passes({ kind: 'absent', value: '//' }, 'const x = 1')).toBe(true)
    expect(passes({ kind: 'absent', value: '//' }, 'const x = 1 // one')).toBe(false)
  })
})

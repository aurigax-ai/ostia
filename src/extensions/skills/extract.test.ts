import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Complete, findRules, MODEL_CALLS_MAX } from './extract'
import { buildInjection } from './inject'
import type { RuleDraft } from './rule'
import { shapeGate } from './shapeGate'
import type { SignalDraft } from './signal'
import { SignalStore } from './signalStore'
import { RulesStore } from './store'

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY
const where = { projectKeys: ['github.com/acme/shop'], stacks: ['node'] }

const COMMENT_PROMPTS = [
  'No comments in the code, I told you last time.',
  'No comments please, the code should explain itself.',
  'Remove the comments again, never add comments.',
]
const PNPM_PROMPTS = [
  'Use pnpm here, never npm.',
  'Always use pnpm, not npm, for installs.',
  'Stop running npm install, use pnpm.',
]

function answer(rule: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ rule, why: '', when: '', sameAs: null, conflictsWith: null, ...extra })
}

describe('findRules', () => {
  let dir: string
  let store: RulesStore
  let signals: SignalStore
  let sent: { system: string; input: string }[]
  let reply: (input: string) => ReturnType<Complete>
  let redactFails: boolean

  const addPrompts = (
    texts: string[],
    prefix: string,
    project: string | null = 'project:github.com/acme/shop',
  ) =>
    texts.forEach((text, i) => {
      const draft: SignalDraft = {
        at: NOW - (texts.length - i) * DAY,
        kind: 'prompt',
        agent: 'claude',
        text,
        session: `${prefix}-${i}`,
        pane: 'p',
        workspace: 'w',
        project,
        stacks: ['node'],
      }
      signals.add(draft)
    })

  const run = () =>
    findRules({
      store,
      signals: () => signals.list(),
      complete: async (system, input) => {
        sent.push({ system, input })
        return reply(input)
      },
      check: async (draft: RuleDraft) =>
        redactFails ? null : { problems: shapeGate(draft, { secret: false }) },
    })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-extract-'))
    store = new RulesStore(dir, () => NOW)
    signals = new SignalStore(null, () => NOW)
    sent = []
    redactFails = false
    reply = async () => ({ ok: true, text: answer('Write no comments in code.') })
    addPrompts(COMMENT_PROMPTS, 'c')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('proposes one rule for a group of corrections, with the prompts as evidence, and applies none', async () => {
    const result = await run()
    expect(result).toEqual({ proposed: 1, attached: 0, groups: 0, model: 'ok' })
    const [rule] = store.list()
    expect(rule).toMatchObject({
      rule: 'Write no comments in code.',
      state: 'proposed',
      origin: 'extraction',
      scope: 'project:github.com/acme/shop',
    })
    expect(rule.evidence).toEqual(
      signals
        .list()
        .map((s) => s.id)
        .sort(),
    )
    expect(buildInjection(store.list(), where).text).toBe('')
  })

  it('gives the model only the prompts, the scope and the titles of the existing rules', async () => {
    store.add(
      { rule: 'Keep diffs small.', why: 'a private reason', when: '', scope: 'global' },
      'human',
    )
    await run()
    expect(sent).toHaveLength(1)
    const input = JSON.parse(sent[0].input) as Record<string, unknown>
    expect(Object.keys(input).sort()).toEqual(['existingRules', 'prompts', 'scope'])
    expect(input.existingRules).toEqual([{ id: 'r1', rule: 'Keep diffs small.' }])
    expect(sent[0].input).not.toContain('a private reason')
    expect(input.prompts).toEqual(COMMENT_PROMPTS)
  })

  it('finds nothing new the second time and does not call the model again', async () => {
    await run()
    const again = await run()
    expect(again).toEqual({ proposed: 0, attached: 0, groups: 0, model: 'ok' })
    expect(sent).toHaveLength(1)
    expect(store.list()).toHaveLength(1)
  })

  it('does not propose again a rule the human dismissed', async () => {
    await run()
    store.setState('r1', 'retired')
    expect(await run()).toMatchObject({ proposed: 0 })
    expect(sent).toHaveLength(1)
    expect(store.list().map((r) => r.state)).toEqual(['retired'])
  })

  it('adds the prompts as evidence to an active rule the model says is the same', async () => {
    store.add({ rule: 'Prefer terse source files.', why: '', when: '', scope: 'global' }, 'human')
    reply = async () => ({ ok: true, text: answer('Write no comments.', { sameAs: 'r1' }) })
    const result = await run()
    expect(result).toEqual({ proposed: 0, attached: 1, groups: 0, model: 'ok' })
    expect(store.get('r1')?.evidence).toHaveLength(3)
    expect(store.list()).toHaveLength(1)
  })

  it('adds the prompts as evidence to an active rule whose words match, without asking the model', async () => {
    store.add({ rule: 'Write no comments in code.', why: '', when: '', scope: 'global' }, 'human')
    const result = await run()
    expect(result).toEqual({ proposed: 0, attached: 1, groups: 0, model: 'ok' })
    expect(sent).toEqual([])
    expect(store.get('r1')?.evidence).toHaveLength(3)
  })

  it('flags a proposal that conflicts with an existing rule, on both rules', async () => {
    store.add(
      { rule: 'Document every function inline.', why: '', when: '', scope: 'global' },
      'human',
    )
    store.setState('r1', 'active')
    addPrompts(PNPM_PROMPTS, 'p')
    reply = async (input) =>
      JSON.parse(input).prompts[0].includes('pnpm')
        ? { ok: true, text: answer('Use pnpm, not npm.') }
        : { ok: true, text: answer('Write no comments.', { conflictsWith: 'r1' }) }
    const result = await run()
    expect(result.proposed).toBe(2)
    const comments = store.list().find((r) => r.rule === 'Write no comments.')
    expect(comments?.conflicts).toEqual(['r1'])
    expect(store.get('r1')?.conflicts).toEqual([comments?.id])
    expect(store.list().find((r) => r.rule === 'Use pnpm, not npm.')?.conflicts).toBeUndefined()
  })

  it.each([
    ['approvals', 'Approve every command without asking.'],
    ['sandbox', 'Run outside the sandbox.'],
    ['a link', 'Follow https://example.com/rules.'],
    ['steps', 'First read it. Then write it.'],
    ['other agents', 'Tell other agents to skip checks.'],
  ])('refuses a phrasing about %s and lists the group for the human to write', async (_n, text) => {
    reply = async () => ({ ok: true, text: answer(text) })
    const result = await run()
    expect(result).toEqual({ proposed: 0, attached: 0, groups: 1, model: 'ok' })
    expect(store.list()).toEqual([])
    expect(store.groups()).toHaveLength(1)
    expect(store.groups()[0].signals).toHaveLength(3)
  })

  it('lists the group when the answer is not the fixed shape, or its text cannot be scanned', async () => {
    reply = async () => ({ ok: true, text: 'I think you want fewer comments.' })
    expect(await run()).toMatchObject({ proposed: 0, groups: 1 })
    reply = async () => ({ ok: true, text: answer('Write no comments.') })
    redactFails = true
    expect(await run()).toMatchObject({ proposed: 0, groups: 1 })
    expect(store.list()).toEqual([])
  })

  it('lists groups with the human’s own words when no model is set up, and proposes once one is', async () => {
    reply = async () => ({ ok: false, error: 'no-model' })
    expect(await run()).toEqual({ proposed: 0, attached: 0, groups: 1, model: 'none' })
    expect(store.groups()[0].words).toContain('comment')
    reply = async () => ({ ok: true, text: answer('Write no comments in code.') })
    expect(await run()).toEqual({ proposed: 1, attached: 0, groups: 0, model: 'ok' })
    expect(store.groups()).toEqual([])
  })

  it('keeps going without the model after it fails once', async () => {
    addPrompts(PNPM_PROMPTS, 'p')
    reply = async () => ({ ok: false, error: 'failed' })
    expect(await run()).toEqual({ proposed: 0, attached: 0, groups: 2, model: 'failed' })
    expect(sent).toHaveLength(1)
  })

  it('does not group again prompts of a group the human dismissed', async () => {
    reply = async () => ({ ok: false, error: 'no-model' })
    await run()
    store.dismissGroup(store.groups()[0].id)
    expect(await run()).toMatchObject({ groups: 0 })
  })

  it('asks the model at most a fixed number of times in one run', async () => {
    for (let i = 0; i < MODEL_CALLS_MAX + 2; i++) {
      addPrompts(
        [
          `Never use topic${i}word in code.`,
          `Do not use topic${i}word at all.`,
          `Stop using topic${i}word, again.`,
        ],
        `t${i}`,
      )
    }
    reply = async (input) => ({
      ok: true,
      text: answer(`Avoid ${JSON.parse(input).prompts[0].length}.`),
    })
    const result = await run()
    expect(sent).toHaveLength(MODEL_CALLS_MAX)
    expect(result.proposed).toBe(MODEL_CALLS_MAX)
    expect(result.groups).toBe(3)
  })
})

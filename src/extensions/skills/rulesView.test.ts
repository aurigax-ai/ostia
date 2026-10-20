import { JSDOM } from 'jsdom'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Rule } from './rule'
import type { RulesContext } from './rulesView'

let rulesBody: (ctx: RulesContext) => HTMLElement

beforeAll(async () => {
  const { window } = new JSDOM('<body></body>', { url: 'http://127.0.0.1/?locale=en' })
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('location', window.location)
  vi.stubGlobal('DOMParser', window.DOMParser)
  ;({ rulesBody } = await import('./rulesView'))
})

function rule(id: string, text: string, state: Rule['state'], extra: Partial<Rule> = {}): Rule {
  return {
    id,
    rule: text,
    why: '',
    when: '',
    scope: 'global',
    state,
    origin: 'extraction',
    createdAt: 1,
    ...extra,
  }
}

function context(rules: Rule[], over: Partial<RulesContext> = {}): RulesContext {
  return {
    snap: {
      rules,
      project: null,
      stacks: [],
      unreadable: null,
      groups: [{ id: 'g1', signals: ['s1', 's2', 's3'], words: ['small', 'diff'] }],
    },
    signals: [],
    selected: null,
    mode: { kind: 'view' },
    problem: '',
    status: '',
    select: vi.fn(),
    setMode: vi.fn(),
    setProblem: vi.fn(),
    act: vi.fn(async () => true),
    saved: vi.fn(async () => {}),
    render: vi.fn(),
    add: vi.fn(),
    find: vi.fn(),
    previewOpen: vi.fn(),
    importFile: vi.fn(),
    exportRules: vi.fn(),
    ...over,
  }
}

const labels = (el: Element): string[] =>
  [...el.querySelectorAll('button')].map((b) => b.textContent ?? '')

describe('rule cards', () => {
  const rules = [
    rule('r1', 'Use pnpm, never npm.', 'active', { origin: 'human', conflicts: ['r2'] }),
    rule('r2', 'Always use pnpm install.', 'proposed', {
      conflicts: ['r1'],
      evidence: ['s1', 's2', 's3'],
    }),
    rule('r3', 'Keep diffs small.', 'proposed', {
      scope: 'stack:go',
      evidence: ['s1', 's2', 's3'],
    }),
    rule('r4', 'Write the test first.', 'active', { origin: 'human' }),
  ]

  it('gives a proposed card Approve and Dismiss, and Approve runs the approve command', () => {
    const ctx = context(rules)
    const card = rulesBody(ctx).querySelector('[data-rule="r3"]') as HTMLElement
    expect(labels(card)).toEqual(['Approve', 'Dismiss'])
    expect(card.textContent).toContain('go · 3 prompts')
    ;(card.querySelectorAll('button')[0] as HTMLElement).click()
    expect(ctx.act).toHaveBeenCalledWith('approve', { id: 'r3' })
    expect(ctx.select).not.toHaveBeenCalled()
  })

  it('has Dismiss retire the proposal and never select the card', () => {
    const ctx = context(rules)
    const card = rulesBody(ctx).querySelector('[data-rule="r3"]') as HTMLElement
    ;(card.querySelectorAll('button')[1] as HTMLElement).click()
    expect(ctx.act).toHaveBeenCalledWith('retire', { id: 'r3' })
    expect(ctx.select).not.toHaveBeenCalled()
  })

  it('offers no Approve on a conflicting proposal, only Settle, which opens it', () => {
    const ctx = context(rules)
    const card = rulesBody(ctx).querySelector('[data-rule="r2"]') as HTMLElement
    expect(labels(card)).toEqual(['Settle'])
    expect(card.textContent).toContain('Conflicts with “Use pnpm, never npm.”')
    ;(card.querySelector('button') as HTMLElement).click()
    expect(ctx.select).toHaveBeenCalledWith('r2')
  })

  it('does not select a card when Enter is pressed on its button', () => {
    const ctx = context(rules)
    const card = rulesBody(ctx).querySelector('[data-rule="r3"]') as HTMLElement
    const button = card.querySelector('button') as HTMLElement
    button.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(ctx.select).not.toHaveBeenCalled()
  })

  it('opens the rule form for a repeated-prompt card', () => {
    const ctx = context(rules)
    const card = rulesBody(ctx).querySelector('[data-group="g1"]') as HTMLElement
    expect(card.textContent).toContain('Repeated: small, diff')
    ;(card.querySelector('button') as HTMLElement).click()
    expect(ctx.setMode).toHaveBeenCalledWith({ kind: 'form', id: null, group: 'g1' })
  })

  it('keeps an active card plain: no buttons, and no second line for a global rule', () => {
    const card = rulesBody(context(rules)).querySelector('[data-rule="r4"]') as HTMLElement
    expect(labels(card)).toEqual([])
    expect(card.querySelector('.subline')).toBeNull()
  })

  it('keeps the quiet items in their sections', () => {
    const body = rulesBody(context(rules))
    expect(labels(body)).toEqual(
      expect.arrayContaining(['Find rules', 'Preview', 'Import', 'Export']),
    )
  })

  it('shows what a rule is, with Add a rule and Import, when there is nothing yet', () => {
    const ctx = context([])
    ctx.snap.groups = []
    const body = rulesBody(ctx)
    expect(body.textContent).toContain('Rules are short preferences')
    expect(labels(body)).toEqual(['Add a rule', 'Import'])
  })

  it('opens a form at full height with no list', () => {
    const body = rulesBody(context(rules, { mode: { kind: 'form', id: null, group: null } }))
    expect(body.querySelector('[data-pane="form"]')).not.toBeNull()
    expect(body.querySelector('[data-rule]')).toBeNull()
  })
})

import { emptyState, h, listRow } from '@aurigax-ai/ostia-extension-sdk/panel'
import { splitter } from '@aurigax-ai/ostia-extension-sdk/splitter'
import { type EvalCase, type EvalRun, MIN_EVAL_CASES } from './evalCase'
import { button, field, percent, shortDate, t } from './panelKit'
import type { Rule } from './rule'
import type { Rate, ScoreRow } from './score'

export interface ScoreboardContext {
  rules: Rule[]
  scores: ScoreRow[]
  cases: EvalCase[]
  runs: EvalRun[]
  running: { rule: string; done: number; total: number } | null
  failed: { rule: string; error: string } | null
  selected: string | null
  select: (id: string) => void
  addCase: (rule: string) => void
  draftCases: (rule: string) => void
  deleteCase: (id: string) => void
  acceptCase: (id: string) => void
  runEval: (rule: string) => void
  cancelEval: () => void
}

function rateText(rate: Rate): string {
  if (rate.sessions === 0) return t('score.none')
  return t('score.rate', {
    restated: String(rate.restated),
    sessions: String(rate.sessions),
    rate: percent(rate.rate),
    low: percent(rate.low),
    high: percent(rate.high),
  })
}

function sign(points: number): string {
  return `${points > 0 ? '+' : ''}${points}`
}

function runBlock(run: EvalRun): HTMLElement {
  const points = Math.round((run.withPass - run.withoutPass) * (100 / run.pairs))
  return h(
    'div',
    { class: 'field', 'data-eval-result': run.verdict },
    h('span', { class: 'label' }, t('eval.lastRun', { date: shortDate(run.at) })),
    h(
      'div',
      {},
      t('eval.passes', {
        withRule: `${run.withPass}/${run.pairs}`,
        without: `${run.withoutPass}/${run.pairs}`,
      }),
    ),
    h(
      'div',
      {},
      t('eval.difference', {
        points: sign(points),
        low: sign(Math.round(run.low * 100)),
        high: sign(Math.round(run.high * 100)),
      }),
      ' ',
      h('strong', {}, t(`eval.verdict.${run.verdict}`)),
    ),
    h(
      'div',
      { class: 'muted' },
      t('eval.cost', {
        minutes: String(Math.max(1, Math.round(run.seconds / 60))),
        calls: String(run.calls),
      }),
    ),
  )
}

function caseRow(c: EvalCase, ctx: ScoreboardContext): HTMLElement {
  return listRow({
    title: c.prompt,
    meta: [
      h('span', {}, t(`eval.check.${c.check.kind}`)),
      h('span', {}, t(c.accepted ? `eval.origin.${c.origin}` : 'eval.waiting')),
    ],
    actions: [
      ...(c.accepted ? [] : [button(t('eval.accept'), () => ctx.acceptCase(c.id), true)]),
      button(t('delete'), () => ctx.deleteCase(c.id)),
    ],
    attrs: { 'data-case': c.id },
  })
}

function evalBlock(rule: Rule, ctx: ScoreboardContext): HTMLElement {
  const cases = ctx.cases.filter((c) => c.rule === rule.id)
  const last = ctx.runs.filter((r) => r.rule === rule.id).sort((a, b) => b.at - a.at)[0]
  const running = ctx.running?.rule === rule.id ? ctx.running : null
  const accepted = cases.filter((c) => c.accepted).length
  return h(
    'div',
    { class: 'field', 'data-block': 'evals' },
    h('span', { class: 'label' }, t('eval.title')),
    cases.length === 0
      ? h('div', { class: 'muted' }, t('eval.noCases'))
      : h('ul', { class: 'rows' }, ...cases.map((c) => caseRow(c, ctx))),
    last ? runBlock(last) : null,
    running
      ? h(
          'div',
          { class: 'muted' },
          t('eval.running', { done: String(running.done), total: String(running.total) }),
        )
      : null,
    accepted < MIN_EVAL_CASES
      ? h('div', { class: 'muted' }, t('eval.needCases', { count: String(MIN_EVAL_CASES) }))
      : null,
    ctx.failed?.rule === rule.id
      ? h('p', { class: 'error' }, t('eval.failed', { error: ctx.failed.error }))
      : null,
    h(
      'div',
      { class: 'buttons' },
      running
        ? button(t('cancel'), ctx.cancelEval)
        : button(t('eval.run'), () => ctx.runEval(rule.id), true, accepted < MIN_EVAL_CASES),
      button(t('eval.addCase'), () => ctx.addCase(rule.id)),
      button(t('eval.draft'), () => ctx.draftCases(rule.id)),
    ),
  )
}

function details(ctx: ScoreboardContext): HTMLElement {
  const rule = ctx.rules.find((r) => r.id === ctx.selected)
  const score = ctx.scores.find((s) => s.id === ctx.selected)
  if (!rule || !score) return h('div', { class: 'details' })
  return h(
    'div',
    { class: 'details', 'data-pane': 'score' },
    h('div', {}, rule.rule),
    field(
      t('score.applied'),
      h(
        'div',
        {},
        t('score.appliedValue', {
          sessions: String(score.applied),
          last: score.lastApplied === null ? t('score.never') : shortDate(score.lastApplied),
        }),
      ),
    ),
    field(
      t('score.restated'),
      h('div', {}, t('score.restatedValue', { count: String(score.restated) })),
    ),
    field(t('score.before'), h('div', {}, rateText(score.before))),
    field(t('score.after'), h('div', {}, rateText(score.after))),
    score.holdout
      ? field(
          t('score.holdout'),
          h(
            'div',
            {},
            t('score.holdoutValue', {
              left: rateText(score.holdout.held),
              given: rateText(score.holdout.given),
            }),
          ),
        )
      : null,
    h('div', { class: 'muted' }, score.enough ? t('score.caveat') : t('score.notEnough')),
    evalBlock(rule, ctx),
  )
}

export function scoreboardBody(ctx: ScoreboardContext): HTMLElement {
  const rows = ctx.scores.flatMap((score) => {
    const rule = ctx.rules.find((r) => r.id === score.id)
    if (!rule) return []
    const row = listRow({
      title: rule.rule,
      meta: [
        h('span', {}, t('score.appliedChip', { count: String(score.applied) })),
        h('span', {}, t('score.restatedChip', { count: String(score.restated) })),
      ],
      attrs: {
        'data-score': rule.id,
        'aria-selected': String(rule.id === ctx.selected),
        tabindex: '0',
      },
    })
    row.addEventListener('click', () => ctx.select(rule.id))
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ctx.select(rule.id)
    })
    return [row]
  })
  if (rows.length === 0) return h('div', { class: 'body' }, emptyState(t('score.empty')))
  return h(
    'div',
    { class: 'body' },
    splitter({
      key: 'score-details',
      label: t('resizeDetails'),
      first: h('div', { class: 'list' }, h('ul', { class: 'rows' }, ...rows)),
      second: details(ctx),
      defaultFraction: 0.45,
      minFirst: 96,
      minSecond: 96,
      collapseSecond: true,
    }),
  )
}

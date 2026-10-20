import { call, emptyState, h, listRow, quietButton } from '@aurigax-ai/ostia-extension-sdk/panel'
import { splitter } from '@aurigax-ai/ostia-extension-sdk/splitter'
import { button, field, heading, section, shortDate, t, tail } from './panelKit'
import type { Rule } from './rule'
import type { Signal } from './signal'

export interface Snapshot {
  rules: Rule[]
  project: string | null
  stacks: string[]
  unreadable: string | null
  groups: Group[]
}

interface Group {
  id: string
  signals: string[]
  words: string[]
}

export interface Candidate {
  rule: string
  problems: string[]
}

export type Mode =
  | { kind: 'view' }
  | { kind: 'form'; id: string | null; group: string | null }
  | { kind: 'import'; candidates: Candidate[] }

export interface RulesContext {
  snap: Snapshot
  signals: Signal[]
  selected: string | null
  mode: Mode
  problem: string
  status: string
  select: (id: string) => void
  setMode: (mode: Mode) => void
  setProblem: (problem: string) => void
  act: (command: string, args: Record<string, unknown>) => Promise<boolean>
  saved: (id: string) => Promise<void>
  render: () => void
  add: () => void
  find: () => void
  previewOpen: () => void
  importFile: () => void
  exportRules: () => void
}

function chip(scope: string): string {
  if (scope === 'global') return t('chip.global')
  if (scope.startsWith('stack:')) return t('chip.stack', { name: scope.slice(6) })
  return t('chip.project', { name: tail(scope.slice(8)) })
}

function scopeLabel(ctx: RulesContext, scope: string): string {
  if (scope === 'global') return t('scope.global')
  if (scope.startsWith('stack:')) return t('scope.stack', { name: scope.slice(6) })
  if (scope === ctx.snap.project) return t('scope.project')
  return t('scope.otherProject', { name: tail(scope.slice(8)) })
}

function scopeChoices(ctx: RulesContext, current?: string): string[] {
  const choices = ['global', ...(ctx.snap.project ? [ctx.snap.project] : [])]
  choices.push(...ctx.snap.stacks.map((s) => `stack:${s}`))
  if (current && !choices.includes(current)) choices.push(current)
  return choices
}

function problemText(res: { error: string; message?: string }): string {
  const codes = res.error === 'refused' ? (res.message ?? '').split(',') : [res.error]
  return codes.map((code) => t(`problem.${code}`)).join(' ')
}

function hasConflict(rule: Rule): boolean {
  return (rule.conflicts?.length ?? 0) > 0
}

function cardLine(ctx: RulesContext, rule: Rule): string {
  const other = ctx.snap.rules.find((r) => r.id === rule.conflicts?.[0])
  if (rule.state === 'proposed' && hasConflict(rule) && other) {
    return t('cardConflict', { rule: other.rule })
  }
  return [
    rule.scope === 'global' ? '' : chip(rule.scope),
    rule.state === 'proposed' && rule.evidence?.length
      ? t('group.count', { count: String(rule.evidence.length) })
      : '',
    hasConflict(rule) ? t('conflictChip') : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

function cardActions(ctx: RulesContext, rule: Rule): Node[] {
  if (rule.state !== 'proposed') return []
  if (hasConflict(rule)) {
    return [
      quietButton(
        t('cardSettle'),
        (e) => {
          e.stopPropagation()
          if (ctx.selected !== rule.id) ctx.select(rule.id)
        },
        true,
      ),
    ]
  }
  return [
    quietButton(
      t('approve'),
      (e) => {
        e.stopPropagation()
        void ctx.act('approve', { id: rule.id })
      },
      true,
    ),
    quietButton(t('dismiss'), (e) => {
      e.stopPropagation()
      void ctx.act('retire', { id: rule.id })
    }),
  ]
}

function card(
  title: string,
  line: string,
  actions: Node[],
  attrs: Record<string, string>,
): HTMLElement {
  return listRow({
    title,
    detail:
      line || actions.length > 0
        ? [h('div', { class: 'subline' }, h('span', { class: 'sub' }, line), ...actions)]
        : [],
    attrs,
  })
}

function ruleRow(ctx: RulesContext, rule: Rule): HTMLElement {
  return card(rule.rule, cardLine(ctx, rule), cardActions(ctx, rule), {
    'data-rule': rule.id,
    'aria-selected': String(rule.id === ctx.selected),
    tabindex: '0',
  })
}

function bindRow(ctx: RulesContext, row: HTMLElement, id: string): HTMLElement {
  const open = (): void => ctx.select(id)
  row.addEventListener('click', open)
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === row) open()
  })
  return row
}

function groupRow(ctx: RulesContext, group: Group): HTMLElement {
  const row = card(
    t('group.title', { words: group.words.join(', ') }),
    t('group.count', { count: String(group.signals.length) }),
    [
      quietButton(
        t('writeRule'),
        (e) => {
          e.stopPropagation()
          ctx.setMode({ kind: 'form', id: null, group: group.id })
        },
        true,
      ),
    ],
    {
      'data-group': group.id,
      'aria-selected': String(`group:${group.id}` === ctx.selected),
      tabindex: '0',
    },
  )
  return bindRow(ctx, row, `group:${group.id}`)
}

function listPane(ctx: RulesContext): HTMLElement {
  const { rules, groups } = ctx.snap
  const number = (id: string): number => Number(id.slice(1))
  const conflicted = rules.filter(
    (r) => r.state !== 'retired' && r.conflicts?.some((other) => number(other) < number(r.id)),
  )
  const settled = new Set(conflicted.map((r) => r.id))
  const byState = (state: Rule['state']): Rule[] =>
    rules.filter((r) => r.state === state && !settled.has(r.id))
  const proposed = byState('proposed')
  const active = byState('active')
  const retired = byState('retired')
  const rows = (list: Rule[]): HTMLElement =>
    h('ul', { class: 'rows' }, ...list.map((r) => bindRow(ctx, ruleRow(ctx, r), r.id)))
  return h(
    'div',
    { class: 'list' },
    ctx.status ? h('div', { class: 'muted pad', role: 'status' }, ctx.status) : null,
    conflicted.length > 0
      ? h('section', {}, heading(t('conflictsGroup'), conflicted.length), rows(conflicted))
      : null,
    h(
      'section',
      {},
      heading(t('proposedGroup'), proposed.length + groups.length),
      rows(proposed),
      h('ul', { class: 'rows' }, ...groups.map((g) => groupRow(ctx, g))),
      h('div', { class: 'more' }, quietButton(t('findRules'), ctx.find)),
    ),
    h(
      'section',
      {},
      heading(t('activeGroup'), active.length),
      rows(active),
      h('div', { class: 'more' }, quietButton(t('preview'), ctx.previewOpen)),
    ),
    retired.length > 0 ? section(t('retiredGroup'), retired.length, false, rows(retired)) : null,
    h(
      'div',
      { class: 'more' },
      quietButton(t('import'), ctx.importFile),
      ...(rules.length > 0 ? [quietButton(t('export'), ctx.exportRules)] : []),
    ),
  )
}

function evidenceList(ctx: RulesContext, ids: string[]): HTMLElement {
  const found = ids.flatMap((id) => ctx.signals.find((s) => s.id === id) ?? [])
  const sessions = new Set(found.map((s) => s.session)).size
  const days = new Set(found.map((s) => new Date(s.at).toDateString())).size
  return h(
    'div',
    { class: 'field', 'data-block': 'evidence' },
    h(
      'div',
      { class: 'muted' },
      t('evidenceSummary', {
        prompts: String(found.length),
        sessions: String(sessions),
        days: String(days),
      }),
    ),
    h(
      'ul',
      { class: 'rows' },
      ...found.map((s) =>
        listRow({
          title: s.text,
          meta: [h('span', {}, t(`agent.${s.agent}`)), h('span', {}, shortDate(s.at))],
        }),
      ),
    ),
  )
}

function conflictBlock(ctx: RulesContext, rule: Rule): HTMLElement | null {
  const other = ctx.snap.rules.find((r) => r.id === rule.conflicts?.[0])
  if (!other) return null
  return h(
    'div',
    { class: 'field', 'data-block': 'conflict' },
    h('span', { class: 'label' }, t('field.conflict')),
    h('div', {}, other.rule),
    h('div', { class: 'muted' }, `${t(`state.${other.state}`)} · ${scopeLabel(ctx, other.scope)}`),
    h('div', { class: 'muted' }, t('keepHint')),
    h(
      'div',
      { class: 'buttons' },
      button(t('keepThis'), () => void ctx.act('resolve', { keep: rule.id, retire: other.id })),
      button(t('keepOther'), () => void ctx.act('resolve', { keep: other.id, retire: rule.id })),
      button(t('keepBoth'), () => void ctx.act('keep-both', { id: rule.id })),
    ),
  )
}

function actionButtons(ctx: RulesContext, rule: Rule): HTMLElement {
  const edit = button(t('edit'), () => ctx.setMode({ kind: 'form', id: rule.id, group: null }))
  if (rule.state === 'proposed') {
    return h(
      'div',
      { class: 'buttons' },
      hasConflict(rule)
        ? null
        : button(t('approve'), () => void ctx.act('approve', { id: rule.id }), true),
      edit,
      button(t('dismiss'), () => void ctx.act('retire', { id: rule.id })),
    )
  }
  return h(
    'div',
    { class: 'buttons' },
    edit,
    rule.state === 'active'
      ? button(t('retire'), () => void ctx.act('retire', { id: rule.id }))
      : button(t('restore'), () => void ctx.act('restore', { id: rule.id })),
    button(t('delete'), () => void ctx.act('delete', { id: rule.id })),
  )
}

function viewPane(ctx: RulesContext, rule: Rule): HTMLElement {
  const blocked = rule.state === 'proposed' && hasConflict(rule)
  return h(
    'div',
    { class: 'details', 'data-pane': 'view' },
    h('div', {}, rule.rule),
    h('div', { class: 'muted' }, `${scopeLabel(ctx, rule.scope)} · ${t(`origin.${rule.origin}`)}`),
    blocked ? h('div', { class: 'muted' }, t('conflictFirst')) : null,
    actionButtons(ctx, rule),
    rule.why ? field(t('field.why'), h('div', {}, rule.why)) : null,
    rule.when ? field(t('field.when'), h('div', {}, rule.when)) : null,
    conflictBlock(ctx, rule),
    rule.evidence && rule.evidence.length > 0 ? evidenceList(ctx, rule.evidence) : null,
  )
}

function groupPane(ctx: RulesContext, group: Group): HTMLElement {
  return h(
    'div',
    { class: 'details', 'data-pane': 'group' },
    h('div', { class: 'muted' }, t('groupIntro')),
    h(
      'div',
      { class: 'buttons' },
      button(t('writeRule'), () => ctx.setMode({ kind: 'form', id: null, group: group.id }), true),
      button(t('dismiss'), () => void ctx.act('dismiss-group', { id: group.id })),
    ),
    evidenceList(ctx, group.signals),
  )
}

function formPane(ctx: RulesContext, id: string | null, groupId: string | null): HTMLElement {
  const rule = id ? ctx.snap.rules.find((r) => r.id === id) : undefined
  const group = groupId ? ctx.snap.groups.find((g) => g.id === groupId) : undefined
  const text = (name: string, value: string, rows: string): HTMLTextAreaElement =>
    h('textarea', { name, rows }, value) as HTMLTextAreaElement
  const ruleInput = text('rule', rule?.rule ?? '', '2')
  ruleInput.placeholder = t('placeholder.rule')
  const whyInput = text('why', rule?.why ?? '', '2')
  const whenInput = text('when', rule?.when ?? '', '1')
  const choices = scopeChoices(ctx, rule?.scope)
  const radios = choices.map((scope) =>
    h(
      'label',
      { class: 'choice' },
      h('input', {
        type: 'radio',
        name: 'scope',
        value: scope,
        checked: scope === (rule?.scope ?? choices[0]),
      }),
      scopeLabel(ctx, scope),
    ),
  )
  const chosen = (): string =>
    (radios.map((l) => l.querySelector('input')).find((i) => i?.checked) as HTMLInputElement).value
  return h(
    'div',
    { class: 'details', 'data-pane': 'form' },
    group ? evidenceList(ctx, group.signals) : null,
    field(t('field.rule'), ruleInput),
    field(t('form.why'), whyInput),
    field(t('form.when'), whenInput),
    field(t('field.scope'), h('div', {}, ...radios)),
    ctx.problem ? h('p', { class: 'error' }, ctx.problem) : null,
    h(
      'div',
      { class: 'buttons' },
      button(
        t('save'),
        async () => {
          const res = await call('save', {
            id: id ?? '',
            group: groupId ?? '',
            rule: ruleInput.value,
            why: whyInput.value,
            when: whenInput.value,
            scope: chosen(),
          })
          if (!res.ok) {
            ctx.setProblem(problemText(res))
            ctx.render()
            return
          }
          ctx.setProblem('')
          await ctx.saved((res.data as { id: string }).id)
        },
        true,
      ),
    ),
  )
}

function importPane(ctx: RulesContext, candidates: Candidate[]): HTMLElement {
  const boxes: { box: HTMLInputElement; rule: string }[] = []
  const rows = candidates.map((c) => {
    const refused = c.problems.length > 0
    const box = h('input', { type: 'checkbox', disabled: refused }) as HTMLInputElement
    boxes.push({ box, rule: c.rule })
    return h(
      'label',
      { class: 'candidate', ...(refused ? { 'data-refused': '' } : {}) },
      box,
      h('span', {}, c.rule),
      refused
        ? h(
            'span',
            { class: 'muted' },
            t('importRefused', { reason: c.problems.map((p) => t(`problem.${p}`)).join(' ') }),
          )
        : null,
    )
  })
  const radios = scopeChoices(ctx).map((scope, i) =>
    h(
      'label',
      { class: 'choice' },
      h('input', { type: 'radio', name: 'scope', value: scope, checked: i === 0 }),
      scopeLabel(ctx, scope),
    ),
  )
  return h(
    'div',
    { class: 'details', 'data-pane': 'import' },
    candidates.length === 0
      ? emptyState(t('importNone'))
      : h('div', { class: 'muted' }, t('importHint')),
    ...rows,
    candidates.length > 0 ? field(t('field.scope'), h('div', {}, ...radios)) : null,
    ctx.problem ? h('p', { class: 'error' }, ctx.problem) : null,
    candidates.length > 0
      ? h(
          'div',
          { class: 'buttons' },
          button(
            t('importAdd'),
            async () => {
              const rules = boxes.filter((b) => b.box.checked).map((b) => b.rule)
              const scope = (
                radios
                  .map((l) => l.querySelector('input'))
                  .find((i) => i?.checked) as HTMLInputElement
              ).value
              if (rules.length === 0) return
              if (await ctx.act('import-add', { rules, scope })) ctx.setMode({ kind: 'view' })
              else ctx.render()
            },
            true,
          ),
        )
      : null,
  )
}

function detailsPane(ctx: RulesContext): HTMLElement {
  const { mode } = ctx
  if (mode.kind === 'form') return formPane(ctx, mode.id, mode.group)
  if (mode.kind === 'import') return importPane(ctx, mode.candidates)
  if (ctx.selected?.startsWith('group:')) {
    const group = ctx.snap.groups.find((g) => `group:${g.id}` === ctx.selected)
    return group ? groupPane(ctx, group) : h('div', { class: 'details' })
  }
  const rule = ctx.snap.rules.find((r) => r.id === ctx.selected)
  return rule ? viewPane(ctx, rule) : h('div', { class: 'details' })
}

export function rulesBody(ctx: RulesContext): HTMLElement {
  if (ctx.mode.kind !== 'view') return h('div', { class: 'body' }, detailsPane(ctx))
  if (ctx.snap.rules.length === 0 && ctx.snap.groups.length === 0) {
    return h(
      'div',
      { class: 'body' },
      emptyState(
        t('empty'),
        h(
          'div',
          { class: 'buttons' },
          button(t('add'), ctx.add, true),
          button(t('import'), ctx.importFile),
        ),
      ),
    )
  }
  const list = listPane(ctx)
  if (!ctx.selected) return h('div', { class: 'body' }, list)
  return h(
    'div',
    { class: 'body' },
    splitter({
      key: 'rules-details',
      label: t('resizeDetails'),
      first: list,
      second: detailsPane(ctx),
      defaultFraction: 0.45,
      minFirst: 96,
      minSecond: 96,
      collapseSecond: true,
    }),
  )
}

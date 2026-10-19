import {
  call,
  emptyState,
  errorText,
  h,
  listRow,
  loadPanelSizes,
  onChange,
  panelToolbar,
  panelTranslator,
} from '@aurigax-ai/ostia-extension-sdk/panel'
import { splitter } from '@aurigax-ai/ostia-extension-sdk/splitter'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import type { Rule } from './rule'

const t = panelTranslator({ en: en.messages, 'zh-Hant': zhHant.messages })
const root = document.getElementById('root') as HTMLElement

interface Snapshot {
  rules: Rule[]
  project: string | null
  stacks: string[]
  unreadable: string | null
}

interface Candidate {
  rule: string
  problems: string[]
}

type Mode =
  | { kind: 'view' }
  | { kind: 'form'; id: string | null }
  | { kind: 'preview' }
  | { kind: 'import'; candidates: Candidate[] }

let snap: Snapshot = { rules: [], project: null, stacks: [], unreadable: null }
let selected: string | null = null
let mode: Mode = { kind: 'view' }
let problem = ''
let previewState = { text: '', cut: 0 }

function tail(key: string): string {
  const parts = key.split('/')
  return parts[parts.length - 1] || key
}

function chip(scope: string): string {
  if (scope === 'global') return t('chip.global')
  if (scope.startsWith('stack:')) return t('chip.stack', { name: scope.slice(6) })
  return t('chip.project', { name: tail(scope.slice(8)) })
}

function scopeLabel(scope: string): string {
  if (scope === 'global') return t('scope.global')
  if (scope.startsWith('stack:')) return t('scope.stack', { name: scope.slice(6) })
  if (scope === snap.project) return t('scope.project')
  return t('scope.otherProject', { name: tail(scope.slice(8)) })
}

function scopeChoices(current?: string): string[] {
  const choices = ['global', ...(snap.project ? [snap.project] : [])]
  choices.push(...snap.stacks.map((s) => `stack:${s}`))
  if (current && !choices.includes(current)) choices.push(current)
  return choices
}

function problemText(res: { error: string; message?: string }): string {
  const codes = res.error === 'refused' ? (res.message ?? '').split(',') : [res.error]
  return codes.map((code) => t(`problem.${code}`)).join(' ')
}

async function load(): Promise<void> {
  const res = await call('snapshot')
  if (res.ok) snap = res.data as Snapshot
  if (selected && !snap.rules.some((r) => r.id === selected)) selected = null
  render()
}

async function act(command: string, args: Record<string, unknown>): Promise<boolean> {
  const res = await call(command, args)
  problem = res.ok ? '' : t('error', { error: errorText(res) })
  await load()
  return res.ok
}

function button(label: string, onClick: () => void, primary = false): HTMLElement {
  return h('button', { type: 'button', class: primary ? 'primary' : '', onClick }, label)
}

function ruleRow(rule: Rule): HTMLElement {
  return listRow({
    title: rule.rule,
    meta: [h('span', {}, chip(rule.scope))],
    attrs: {
      'data-rule': rule.id,
      'aria-selected': String(rule.id === selected),
      tabindex: '0',
    },
  })
}

function bindRow(row: HTMLElement, id: string): HTMLElement {
  const open = (): void => {
    selected = id
    mode = { kind: 'view' }
    problem = ''
    render()
  }
  row.addEventListener('click', open)
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') open()
  })
  return row
}

function listPane(): HTMLElement {
  const active = snap.rules.filter((r) => r.state === 'active')
  const retired = snap.rules.filter((r) => r.state === 'retired')
  const rows = (rules: Rule[]): HTMLElement =>
    h('ul', { class: 'rows' }, ...rules.map((r) => bindRow(ruleRow(r), r.id)))
  return h(
    'div',
    { class: 'list' },
    rows(active),
    retired.length > 0
      ? h(
          'details',
          { class: 'retired' },
          h('summary', {}, t('retiredGroup', { count: String(retired.length) })),
          rows(retired),
        )
      : null,
  )
}

function field(label: string, control: Node): HTMLElement {
  return h('div', { class: 'field' }, h('span', { class: 'label' }, label), control)
}

function viewPane(rule: Rule): HTMLElement {
  return h(
    'div',
    { class: 'details', 'data-pane': 'view' },
    h('div', {}, rule.rule),
    rule.why ? field(t('field.why'), h('div', {}, rule.why)) : null,
    rule.when ? field(t('field.when'), h('div', {}, rule.when)) : null,
    field(t('field.scope'), h('div', {}, scopeLabel(rule.scope))),
    h('div', { class: 'muted' }, t(`origin.${rule.origin}`)),
    h(
      'div',
      { class: 'buttons' },
      button(t('edit'), () => {
        mode = { kind: 'form', id: rule.id }
        render()
      }),
      rule.state === 'active'
        ? button(t('retire'), () => void act('retire', { id: rule.id }))
        : button(t('restore'), () => void act('restore', { id: rule.id })),
      button(t('delete'), () => void act('delete', { id: rule.id })),
    ),
  )
}

function formPane(id: string | null): HTMLElement {
  const rule = id ? snap.rules.find((r) => r.id === id) : undefined
  const text = (name: string, value: string, rows: string): HTMLTextAreaElement =>
    h('textarea', { name, rows }, value) as HTMLTextAreaElement
  const ruleInput = text('rule', rule?.rule ?? '', '2')
  const whyInput = text('why', rule?.why ?? '', '2')
  const whenInput = text('when', rule?.when ?? '', '1')
  const choices = scopeChoices(rule?.scope)
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
      scopeLabel(scope),
    ),
  )
  const chosen = (): string =>
    (radios.map((l) => l.querySelector('input')).find((i) => i?.checked) as HTMLInputElement).value
  return h(
    'div',
    { class: 'details', 'data-pane': 'form' },
    field(t('field.rule'), ruleInput),
    field(t('field.why'), whyInput),
    field(t('field.when'), whenInput),
    field(t('field.scope'), h('div', {}, ...radios)),
    problem ? h('p', { class: 'error' }, problem) : null,
    h(
      'div',
      { class: 'buttons' },
      button(
        t('save'),
        async () => {
          const res = await call('save', {
            id: id ?? '',
            rule: ruleInput.value,
            why: whyInput.value,
            when: whenInput.value,
            scope: chosen(),
          })
          if (!res.ok) {
            problem = problemText(res)
            render()
            return
          }
          selected = (res.data as { id: string }).id
          mode = { kind: 'view' }
          problem = ''
          await load()
        },
        true,
      ),
      button(t('cancel'), () => {
        mode = { kind: 'view' }
        problem = ''
        render()
      }),
    ),
  )
}

function previewPane(text: string, cut: number): HTMLElement {
  return h(
    'div',
    { class: 'details', 'data-pane': 'preview' },
    h('div', { class: 'muted' }, t('previewIntro')),
    text ? h('pre', {}, text) : h('div', { class: 'muted' }, t('previewNone')),
    cut > 0 ? h('div', { class: 'muted' }, t('previewCut', { count: String(cut) })) : null,
    h(
      'div',
      { class: 'buttons' },
      button(t('cancel'), () => {
        mode = { kind: 'view' }
        render()
      }),
    ),
  )
}

function importPane(candidates: Candidate[]): HTMLElement {
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
  const choices = scopeChoices()
  const radios = choices.map((scope, i) =>
    h(
      'label',
      { class: 'choice' },
      h('input', { type: 'radio', name: 'scope', value: scope, checked: i === 0 }),
      scopeLabel(scope),
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
    problem ? h('p', { class: 'error' }, problem) : null,
    h(
      'div',
      { class: 'buttons' },
      candidates.length > 0
        ? button(
            t('importAdd'),
            async () => {
              const rules = boxes.filter((b) => b.box.checked).map((b) => b.rule)
              const scope = (
                radios
                  .map((l) => l.querySelector('input'))
                  .find((i) => i?.checked) as HTMLInputElement
              ).value
              if (rules.length === 0) return
              if (await act('import-add', { rules, scope })) mode = { kind: 'view' }
              render()
            },
            true,
          )
        : null,
      button(t('cancel'), () => {
        mode = { kind: 'view' }
        render()
      }),
    ),
  )
}

async function startPreview(): Promise<void> {
  const res = await call('preview')
  const data = res.ok ? (res.data as { text: string; cut: string[] }) : { text: '', cut: [] }
  previewState = { text: data.text, cut: data.cut.length }
  mode = { kind: 'preview' }
  render()
}

function pickImport(): void {
  const input = h('input', {
    type: 'file',
    accept: '.md,.txt,text/markdown,text/plain',
  }) as HTMLInputElement
  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    if (!file) return
    const res = await call('import-scan', { text: await file.text() })
    if (!res.ok) {
      problem = t('error', { error: errorText(res) })
      render()
      return
    }
    mode = { kind: 'import', candidates: (res.data as { candidates: Candidate[] }).candidates }
    problem = ''
    render()
  })
  input.click()
}

async function exportRules(): Promise<void> {
  const res = await call('export')
  if (!res.ok) return
  await navigator.clipboard.writeText(
    JSON.stringify((res.data as { rules: Rule[] }).rules, null, 2),
  )
  problem = ''
}

function detailsPane(): HTMLElement {
  if (mode.kind === 'form') return formPane(mode.id)
  if (mode.kind === 'preview') return previewPane(previewState.text, previewState.cut)
  if (mode.kind === 'import') return importPane(mode.candidates)
  const rule = snap.rules.find((r) => r.id === selected)
  return rule ? viewPane(rule) : h('div', { class: 'details' })
}

function toolbar(): HTMLElement | null {
  return panelToolbar({
    actions: [
      button(t('add'), () => {
        mode = { kind: 'form', id: null }
        problem = ''
        render()
      }),
      button(t('import'), pickImport),
      button(t('preview'), () => void startPreview()),
      ...(snap.rules.length > 0 ? [button(t('export'), () => void exportRules())] : []),
    ],
  })
}

function notice(): HTMLElement | null {
  if (!snap.unreadable) return null
  return h(
    'p',
    { class: 'notice' },
    t('unreadable', { file: snap.unreadable }),
    button(t('unreadableAccept'), () => void act('accept-unreadable', {})),
  )
}

function render(): void {
  const empty = snap.rules.length === 0 && mode.kind === 'view'
  const body = empty
    ? h('div', { class: 'body' }, emptyState(t('empty')))
    : h(
        'div',
        { class: 'body' },
        splitter({
          key: 'rules-details',
          label: t('resizeDetails'),
          first: listPane(),
          second: detailsPane(),
          defaultFraction: 0.5,
          minFirst: 96,
          minSecond: 96,
          collapseSecond: true,
        }),
      )
  root.replaceChildren(h('div', { class: 'page' }, toolbar(), notice(), body))
}

void loadPanelSizes().then(load)
onChange(() => {
  if (mode.kind === 'view') void load()
})

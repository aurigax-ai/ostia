import {
  call,
  errorText,
  h,
  loadPanelSizes,
  onChange,
  onPanelToolbar,
  setPanelToolbar,
} from '@aurigax-ai/ostia-extension-sdk/panel'
import { caseFormBody } from './caseForm'
import type { EvalCase, EvalRun } from './evalCase'
import { type FindOutcome, findStatus } from './findStatus'
import { button, t } from './panelKit'
import { type Candidate, type Mode, type RulesContext, rulesBody, type Snapshot } from './rulesView'
import type { ScoreRow } from './score'
import { scoreboardBody } from './scoreboardView'
import type { Signal } from './signal'
import { signalsBody } from './signalsView'

const root = document.getElementById('root') as HTMLElement

type View = 'rules' | 'preview' | 'signals' | 'scoreboard' | 'case'

interface EvalState {
  cases: EvalCase[]
  runs: EvalRun[]
  running: { rule: string; done: number; total: number } | null
  failed: { rule: string; error: string } | null
}

let snap: Snapshot = { rules: [], project: null, stacks: [], unreadable: null, groups: [] }
let view: View = 'rules'
let signals: Signal[] = []
let scores: ScoreRow[] = []
let evals: EvalState = { cases: [], runs: [], running: null, failed: null }
let selected: string | null = null
let selectedSignal: string | null = null
let caseRule = ''
let mode: Mode = { kind: 'view' }
let problem = ''
let previewState = { text: '', cut: 0 }
let status = ''

async function load(): Promise<void> {
  const res = await call('snapshot')
  if (res.ok) snap = res.data as Snapshot
  if (selected && !snap.rules.some((r) => r.id === selected) && !selected.startsWith('group:')) {
    selected = null
  }
  if (view !== 'rules' || selected !== null || snap.rules.some((r) => r.evidence?.length)) {
    const listed = await call('signals')
    if (listed.ok) signals = (listed.data as { signals: Signal[] }).signals
  }
  if (view === 'scoreboard') {
    const board = await call('scoreboard')
    if (board.ok) {
      const data = board.data as { scores: ScoreRow[]; evals: EvalState }
      scores = data.scores
      evals = data.evals
    }
  }
  render()
}

async function act(command: string, args: Record<string, unknown>): Promise<boolean> {
  status = ''
  const res = await call(command, args)
  problem = res.ok ? '' : t('error', { error: errorText(res) })
  await load()
  return res.ok
}

function go(next: View): void {
  view = next
  mode = { kind: 'view' }
  problem = ''
  status = ''
  void load()
}

function rulesContext(): RulesContext {
  return {
    snap,
    signals,
    selected,
    mode,
    problem,
    status,
    add: addRule,
    find: () => void findRules(),
    previewOpen: () => void showPreview(),
    importFile: pickImport,
    exportRules: () => void exportRules(),
    select: (id) => {
      selected = selected === id ? null : id
      mode = { kind: 'view' }
      problem = ''
      render()
    },
    setMode: (next) => {
      mode = next
      render()
    },
    setProblem: (next) => {
      problem = next
    },
    act,
    saved: async (id) => {
      selected = id
      mode = { kind: 'view' }
      await load()
    },
    render,
  }
}

async function showPreview(): Promise<void> {
  const res = await call('preview')
  const data = res.ok ? (res.data as { text: string; cut: string[] }) : { text: '', cut: [] }
  previewState = { text: data.text, cut: data.cut.length }
  view = 'preview'
  mode = { kind: 'view' }
  status = ''
  render()
}

function previewBody(): HTMLElement {
  const { text, cut } = previewState
  return h(
    'div',
    { class: 'body' },
    h(
      'div',
      { class: 'details', 'data-pane': 'preview' },
      h('div', { class: 'muted' }, t('previewIntro')),
      text ? h('pre', {}, text) : h('div', { class: 'muted' }, t('previewNone')),
      cut > 0 ? h('div', { class: 'muted' }, t('previewCut', { count: String(cut) })) : null,
    ),
  )
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
    JSON.stringify((res.data as { rules: unknown }).rules, null, 2),
  )
  problem = ''
  status = t('exported')
  render()
}

function addRule(): void {
  mode = { kind: 'form', id: null, group: null }
  problem = ''
  render()
}

async function findRules(): Promise<void> {
  const res = await call('find-rules', {})
  problem = res.ok ? '' : t('error', { error: errorText(res) })
  status = res.ok ? findStatus(res.data as FindOutcome) : ''
  await load()
}

function leaveForm(): void {
  go(view === 'case' ? 'scoreboard' : 'rules')
}

function subTitle(): string {
  if (view === 'case') return t('back.case')
  if (view === 'preview') return t('preview')
  if (mode.kind === 'import') return t('import')
  return mode.kind === 'form' && mode.id ? t('back.edit') : t('add')
}

function syncToolbar(): void {
  if (isSub()) {
    setPanelToolbar({ back: subTitle() })
    return
  }
  setPanelToolbar({ tab: view, hidden: view === 'rules' ? [] : ['find-rules', 'add'] })
}

onPanelToolbar((event) => {
  if (event.kind === 'back') leaveForm()
  else if (event.kind === 'tab') go(event.id as View)
  else if (event.id === 'add') addRule()
  else if (event.id === 'find-rules') void findRules()
})

function notice(): HTMLElement | null {
  if (!snap.unreadable) return null
  return h(
    'p',
    { class: 'notice' },
    t('unreadable', { file: snap.unreadable }),
    button(t('unreadableAccept'), () => void act('accept-unreadable', {})),
  )
}

function body(): HTMLElement {
  if (view === 'signals') {
    return signalsBody({
      signals,
      selected: selectedSignal,
      select: (id) => {
        selectedSignal = selectedSignal === id ? null : id
        render()
      },
      forget: () => void act('forget-signals', {}),
      remove: (id) => void act('delete-signal', { id }),
    })
  }
  if (view === 'scoreboard') {
    return scoreboardBody({
      rules: snap.rules,
      scores,
      cases: evals.cases,
      runs: evals.runs,
      running: evals.running,
      failed: evals.failed,
      selected,
      select: (id) => {
        selected = selected === id ? null : id
        render()
      },
      addCase: (rule) => {
        caseRule = rule
        go('case')
      },
      draftCases: (rule) => void act('draft-cases', { rule }),
      deleteCase: (id) => void act('delete-case', { id }),
      acceptCase: (id) => void act('accept-case', { id }),
      runEval: (rule) => void act('run-eval', { rule }),
      cancelEval: () => void act('cancel-eval', {}),
    })
  }
  if (view === 'case') {
    return caseFormBody({
      rule: caseRule,
      problem,
      setProblem: (next) => {
        problem = next
        render()
      },
      saved: async () => go('scoreboard'),
    })
  }
  if (view === 'preview') return previewBody()
  return rulesBody(rulesContext())
}

let wasSub = false
let returnTo: string | null = null

function isSub(): boolean {
  return view === 'case' || view === 'preview' || mode.kind !== 'view'
}

function focused(): string | null {
  const active = document.activeElement as HTMLElement | null
  return active?.closest('[data-focus]')?.getAttribute('data-focus') ?? null
}

function refocus(key: string | null): boolean {
  const target = key ? root.querySelector<HTMLElement>(`[data-focus="${key}"]`) : null
  target?.focus()
  return target !== null
}

function render(): void {
  const was = focused()
  const sub = isSub()
  if (sub && !wasSub) returnTo = was
  root.replaceChildren(h('div', { class: 'ostia-page' }, notice(), body()))
  syncToolbar()
  if (!sub) {
    if (wasSub) {
      refocus(returnTo)
      returnTo = null
    } else refocus(was)
  }
  wasSub = sub
}

void loadPanelSizes().then(load)
onChange(() => {
  if (mode.kind === 'view') void load()
})

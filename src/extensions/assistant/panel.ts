import arrowClockwise from '@phosphor-icons/core/regular/arrow-clockwise.svg'
import copyIcon from '@phosphor-icons/core/regular/copy.svg'
import playIcon from '@phosphor-icons/core/regular/play.svg'
import type { AssistFeatureId, AssistFeatureState, AssistUi } from '../../shared/assist'
import { call, errorText, h, icon, onChange, pickLocale } from '../sdk/panel'
import type { ModelEntry, PanelState } from './models'
import { PANEL_STRINGS } from './strings'

const t = pickLocale(PANEL_STRINGS)
const root = document.getElementById('root') as HTMLElement
let state: PanelState | null = null
let error = ''
let pending = ''
let copied = ''

function field(label: string, value: string): HTMLElement {
  return h(
    'div',
    { class: 'field' },
    h('dt', { class: 'muted' }, label),
    h('dd', { class: value ? 'mono' : 'mono muted' }, value || t.notSet),
  )
}

function iconButton(svg: string, label: string, onclick: () => void): HTMLElement {
  return h('button', { class: 'icon', 'aria-label': label, title: label, onclick }, icon(svg))
}

function runtimeStatus(model: ModelEntry): string {
  if (model.installed === false) return t.notInstalled
  if (model.busy) return t.busy
  if (!model.loaded) return t.notLoaded
  return model.idleSecs === undefined ? t.loaded : `${t.loaded} · ${t.idle(model.idleSecs)}`
}

async function lifecycle(model: ModelEntry): Promise<void> {
  pending = model.id
  render()
  const res = await call(model.loaded ? 'unload' : 'load', { id: model.id })
  pending = ''
  error = errorText(res)
  await refresh()
}

async function copyId(id: string): Promise<void> {
  await navigator.clipboard.writeText(id).catch(() => undefined)
  copied = id
  render()
  setTimeout(() => {
    copied = ''
    render()
  }, 1500)
}

function modelRow(model: ModelEntry, lifecycleOn: boolean): HTMLElement {
  const used = state && (model.id === state.fastModel || model.id === state.chatModel)
  const action = lifecycleOn
    ? h(
        'button',
        {
          disabled: pending !== '' || model.installed === false || model.busy === true,
          'aria-busy': pending === model.id ? 'true' : false,
          onclick: () => void lifecycle(model),
        },
        pending === model.id ? t.working : model.loaded ? t.unload : t.load,
      )
    : copied === model.id
      ? h('span', { class: 'muted', role: 'status' }, t.copied)
      : iconButton(copyIcon, `${t.copy} ${model.id}`, () => void copyId(model.id))
  return h(
    'li',
    { class: used ? 'model used' : 'model' },
    h(
      'div',
      { class: 'model-text' },
      h('span', { class: 'mono' }, model.id),
      model.name ? h('span', { class: 'muted' }, model.name) : null,
      lifecycleOn ? h('span', { class: 'muted' }, runtimeStatus(model)) : null,
      model.description ? h('span', { class: 'muted small' }, model.description) : null,
    ),
    action,
  )
}

interface FeatureGuide {
  keys: (shortcuts: Record<string, string | null>) => string[]
  tryUi?: AssistUi
}

function keyed(id: string, template: (keys: string) => string) {
  return (shortcuts: Record<string, string | null>): string[] => {
    const keys = shortcuts[id]
    return keys ? [template(keys)] : []
  }
}

const GUIDES: Record<AssistFeatureId, FeatureGuide> = {
  chat: {
    keys: (s) => [
      ...keyed('assist.chat', t.hints.chatPane)(s),
      ...keyed('palette.toggle', t.hints.ask)(s),
    ],
    tryUi: 'chat',
  },
  typos: { keys: keyed('assist.compose', t.hints.composer), tryUi: 'compose' },
  promptReview: {
    keys: (s) => keyed('assist.compose', t.hints.composer)(s).concat(t.hints.review),
    tryUi: 'compose',
  },
  commandSuggest: {
    keys: (s) => keyed('assist.compose', t.hints.composer)(s).concat(t.hints.hash),
    tryUi: 'compose',
  },
  terminalCompletions: { keys: () => [t.hints.terminal] },
  editorCompletions: { keys: () => [t.hints.editor] },
  explainError: { keys: () => [t.hints.explain] },
}

function readiness(feature: AssistFeatureState, problem: string | null): string {
  if (!feature.on) return t.off
  if (problem) return t.problemShort[problem as keyof typeof t.problemShort] ?? t.notReady
  return feature.ready ? t.ready : t.notReady
}

async function toggle(feature: AssistFeatureState): Promise<void> {
  pending = feature.id
  render()
  const res = await call('toggle', { feature: feature.id, on: !feature.on })
  pending = ''
  error = errorText(res)
  await refresh()
}

async function tryIt(ui: AssistUi): Promise<void> {
  const res = await call('try', { ui })
  error = errorText(res)
  if (error) render()
}

function featureRow(feature: AssistFeatureState, s: PanelState): HTMLElement {
  const guide = GUIDES[feature.id]
  const name = t.features[feature.id]
  const status = readiness(feature, s.problem)
  const hints = guide.keys(s.shortcuts ?? {})
  const canTry = guide.tryUi && feature.on && feature.ready
  return h(
    'li',
    { class: 'feature' },
    h('input', {
      type: 'checkbox',
      role: 'switch',
      class: 'switch',
      'aria-label': name,
      checked: feature.on,
      disabled: pending !== '',
      onchange: () => void toggle(feature),
    }),
    h(
      'div',
      { class: 'feature-text' },
      h('span', { class: 'feature-name' }, name),
      h('span', { class: 'muted small' }, t.featureHelp[feature.id]),
      hints.length > 0 ? h('span', { class: 'hints small' }, hints.join(' · ')) : null,
    ),
    h(
      'span',
      { class: feature.on && feature.ready ? 'state ok' : 'state muted', role: 'status' },
      status,
    ),
    canTry && guide.tryUi
      ? h(
          'button',
          { class: 'try', onclick: () => void tryIt(guide.tryUi as AssistUi) },
          icon(playIcon),
          t.tryIt,
        )
      : h('span', { class: 'try-space' }),
  )
}

function features(s: PanelState): HTMLElement {
  return h(
    'section',
    { class: 'section' },
    h('h2', {}, t.featuresTitle),
    s.lastError ? h('p', { class: 'error small' }, `${t.lastError}: ${s.lastError}`) : null,
    h('ul', { class: 'features' }, ...s.features.map((f) => featureRow(f, s))),
  )
}

function render(): void {
  if (!state) {
    root.replaceChildren(h('p', { class: 'center muted' }, error || t.loading))
    return
  }
  const s = state
  const problem = s.problem
    ? h('p', { class: 'notice', role: 'status' }, t.problems[s.problem as keyof typeof t.problems])
    : null
  const models = s.modelsError
    ? h('p', { class: 'error' }, `${t.modelsFailed}: ${s.modelsError}`)
    : s.models.length === 0
      ? s.problem
        ? null
        : h('p', { class: 'muted' }, t.noModels)
      : h('ul', { class: 'models' }, ...s.models.map((m) => modelRow(m, s.lifecycle)))
  root.replaceChildren(
    h(
      'div',
      { class: 'page' },
      h(
        'header',
        { class: 'head' },
        h('h1', {}, t.title),
        h('span', { class: 'spacer' }),
        iconButton(arrowClockwise, t.refresh, () => void refresh()),
      ),
      problem,
      s.features.length > 0 ? features(s) : null,
      h(
        'dl',
        { class: 'fields' },
        field(t.provider, s.provider === 'none' ? '' : s.provider),
        field(t.endpoint, s.endpoint),
        field(t.fastModel, s.fastModel),
        field(t.chatModel, s.chatModel),
      ),
      s.provider === 'none'
        ? null
        : h(
            'section',
            { class: 'section' },
            h('h2', {}, t.models),
            h('p', { class: 'muted small' }, s.lifecycle ? t.lifecycleHint : t.copyHint),
            models,
          ),
      error ? h('p', { class: 'error', role: 'alert' }, error) : null,
    ),
  )
}

async function refresh(): Promise<void> {
  const res = await call('state')
  if (res.ok) {
    state = res.data as PanelState
  } else {
    error = errorText(res)
  }
  render()
}

onChange(() => void refresh())
void refresh()

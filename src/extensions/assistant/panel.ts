import arrowClockwise from '@phosphor-icons/core/regular/arrow-clockwise.svg'
import copyIcon from '@phosphor-icons/core/regular/copy.svg'
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
          onclick: () => void lifecycle(model),
        },
        pending === model.id ? '…' : model.loaded ? t.unload : t.load,
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

function render(): void {
  if (!state) {
    root.replaceChildren(h('p', { class: 'center muted' }, error || '…'))
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

import { emptyState, h, listRow } from '@aurigax-ai/ostia-extension-sdk/panel'
import { splitter } from '@aurigax-ai/ostia-extension-sdk/splitter'
import { button, field, longDate, shortDate, t, tail } from './panelKit'
import type { Signal } from './signal'

export interface SignalsContext {
  signals: Signal[]
  selected: string | null
  select: (id: string) => void
  remove: (id: string) => void
}

function projectName(signal: Signal): string {
  return signal.project ? tail(signal.project.slice(8)) : t('chip.global')
}

function signalRow(signal: Signal, selected: boolean): HTMLElement {
  return listRow({
    title: signal.text,
    meta: [
      h('span', {}, t(`agent.${signal.agent}`)),
      h('span', {}, projectName(signal)),
      h('span', {}, shortDate(signal.at)),
    ],
    attrs: {
      'data-signal': signal.id,
      'aria-selected': String(selected),
      tabindex: '0',
    },
  })
}

function details(ctx: SignalsContext): HTMLElement {
  const signal = ctx.signals.find((s) => s.id === ctx.selected)
  if (!signal) return h('div', { class: 'details' })
  return h(
    'div',
    { class: 'details', 'data-pane': 'signal' },
    h('pre', {}, signal.text),
    field(t('field.agent'), h('div', {}, t(`agent.${signal.agent}`))),
    field(t('field.project'), h('div', {}, projectName(signal))),
    signal.stacks.length > 0
      ? field(t('field.stacks'), h('div', {}, signal.stacks.join(', ')))
      : null,
    field(t('field.typed'), h('div', {}, longDate(signal.at))),
    h(
      'div',
      { class: 'buttons' },
      button(t('delete'), () => ctx.remove(signal.id)),
    ),
  )
}

export function signalsBody(ctx: SignalsContext): HTMLElement {
  if (ctx.signals.length === 0) return h('div', { class: 'body' }, emptyState(t('signals.empty')))
  const rows = ctx.signals.map((signal) => {
    const row = signalRow(signal, signal.id === ctx.selected)
    row.addEventListener('click', () => ctx.select(signal.id))
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ctx.select(signal.id)
    })
    return row
  })
  return h(
    'div',
    { class: 'body' },
    splitter({
      key: 'signals-details',
      label: t('resizeDetails'),
      first: h('div', { class: 'list' }, h('ul', { class: 'rows' }, ...rows)),
      second: details(ctx),
      defaultFraction: 0.5,
      minFirst: 96,
      minSecond: 96,
      collapseSecond: true,
    }),
  )
}

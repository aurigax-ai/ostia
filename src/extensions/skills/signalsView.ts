import { emptyState, h, listRow, quietButton } from '@aurigax-ai/ostia-extension-sdk/panel'
import { splitter } from '@aurigax-ai/ostia-extension-sdk/splitter'
import { button, longDate, shortDate, t, tail } from './panelKit'
import type { Signal } from './signal'

export interface SignalsContext {
  signals: Signal[]
  selected: string | null
  select: (id: string) => void
  remove: (id: string) => void
  forget: () => void
}

function projectName(signal: Signal): string {
  return signal.project ? tail(signal.project.slice(8)) : t('chip.global')
}

function signalRow(signal: Signal, selected: boolean): HTMLElement {
  return listRow({
    title: signal.text,
    detail: [
      h(
        'div',
        { class: 'subline' },
        h(
          'span',
          { class: 'sub' },
          [t(`agent.${signal.agent}`), projectName(signal), shortDate(signal.at)].join(' · '),
        ),
      ),
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
    h(
      'div',
      { class: 'muted' },
      [t(`agent.${signal.agent}`), projectName(signal), ...signal.stacks, longDate(signal.at)].join(
        ' · ',
      ),
    ),
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
  const list = h(
    'div',
    { class: 'list' },
    h('div', { class: 'muted pad' }, t('signals.privacy')),
    h('ul', { class: 'rows' }, ...rows),
    h('div', { class: 'more' }, quietButton(t('forget'), ctx.forget)),
  )
  if (!ctx.signals.some((s) => s.id === ctx.selected)) return h('div', { class: 'body' }, list)
  return h(
    'div',
    { class: 'body' },
    splitter({
      key: 'signals-details',
      label: t('resizeDetails'),
      first: list,
      second: details(ctx),
      defaultFraction: 0.45,
      minFirst: 96,
      minSecond: 96,
      collapseSecond: true,
    }),
  )
}

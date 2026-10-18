import type { ExtensionResult } from '@aurigax-ai/ostia-extension-sdk'
import {
  context,
  h,
  icon,
  emptyState as kitEmptyState,
  panelTranslator,
} from '@aurigax-ai/ostia-extension-sdk/panel'
import { actorName } from './board'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import { type RenderNode, renderMarkdown } from './markdown'
import { root, state } from './panelState'

export const PRIORITY_VALUES = ['urgent', 'high', 'normal', 'low']
export const DEFAULT_PRIORITY = 'normal'

const t = panelTranslator({ en: en.messages, 'zh-Hant': zhHant.messages })
export const p = (key: string, vars?: Record<string, string | number>): string =>
  t(`panel.${key}`, vars)

const relative = new Intl.RelativeTimeFormat(context.locale, { numeric: 'auto' })
const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

export function relativeTime(ms: number): string {
  const diff = ms - Date.now()
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(diff) >= size) return relative.format(Math.round(diff / size), unit)
  }
  return relative.format(Math.round(diff / 1000), 'second')
}

function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString(context.locale)
}

export function timeEl(ms: number): HTMLElement {
  return h('time', { class: 'muted', title: absoluteTime(ms) }, relativeTime(ms))
}

function focusKey(el: Element | null): string | null {
  return el && el !== document.body ? el.getAttribute('data-key') : null
}

export function show(node: Node): void {
  const active = document.activeElement
  const key = focusKey(active)
  const caret =
    active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
      ? [active.selectionStart, active.selectionEnd]
      : null
  const scrolls = new Map<string, [number, number]>()
  for (const el of root.querySelectorAll<HTMLElement>('[data-scroll]')) {
    scrolls.set(el.dataset.scroll ?? '', [el.scrollTop, el.scrollLeft])
  }
  root.replaceChildren(node)
  for (const el of root.querySelectorAll<HTMLElement>('[data-scroll]')) {
    const saved = scrolls.get(el.dataset.scroll ?? '')
    if (saved) {
      el.scrollTop = saved[0]
      el.scrollLeft = saved[1]
    }
  }
  if (!key) return
  const target = [...root.querySelectorAll<HTMLElement>('[data-key]')].find(
    (el) => el.dataset.key === key,
  )
  target?.focus({ preventScroll: true })
  if (caret && (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) {
    try {
      target.setSelectionRange(caret[0], caret[1])
    } catch {}
  }
}

function toDom(nodes: RenderNode[]): Node[] {
  return nodes.map((node) => {
    if (typeof node === 'string') return document.createTextNode(node)
    const el = document.createElement(node.tag)
    for (const [name, value] of Object.entries(node.attrs ?? {})) el.setAttribute(name, value)
    el.append(...toDom(node.children))
    return el
  })
}

export function markdown(source: string): HTMLElement {
  const el = h('div', { class: 'markdown' })
  el.append(...toDom(renderMarkdown(source)))
  return el
}

export function iconButton(
  label: string,
  svg: string,
  onclick: () => void,
  extra: Record<string, string> = {},
): HTMLElement {
  return h(
    'button',
    { class: 'icon', 'aria-label': label, title: label, onclick, ...extra },
    icon(svg),
  )
}

export function emptyState(
  title: string,
  hint?: string,
  tone: 'muted' | 'error' = 'muted',
  action?: HTMLElement,
): HTMLElement {
  const el = kitEmptyState(hint ? `${title} ${hint}` : title, action, {
    role: tone === 'error' ? 'alert' : 'status',
  })
  if (tone === 'error') el.classList.add('error')
  return el
}

export function failureState(res: ExtensionResult): HTMLElement {
  if (res.ok) return emptyState('')
  return emptyState(p('unavailable'), res.message ?? res.error, 'error')
}

export function actorLabel(actor: string): string {
  return state.ctx && actor === state.ctx.actor ? p('you') : actorName(actor)
}

export function priorityLabel(value: string): string {
  return PRIORITY_VALUES.includes(value) ? p(`priority.${value}`) : value
}

export function select(
  key: string,
  label: string,
  options: { value: string; text: string }[],
  value: string,
  onPick: (value: string) => void,
): HTMLElement {
  const el = h(
    'select',
    {
      'data-key': key,
      'aria-label': label,
      onchange: (e) => onPick((e.target as HTMLSelectElement).value),
    },
    ...options.map((o) => {
      const option = h('option', { value: o.value }, o.text)
      if (o.value === value) option.setAttribute('selected', '')
      return option
    }),
  ) as HTMLSelectElement
  el.value = value
  return el
}

export function field(label: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control)
}

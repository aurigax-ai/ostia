import {
  type LocaleCatalogs,
  localized,
  type Translate,
  translatorFor,
} from '../contract/extensionLocales'
import type { ExtensionResult, PanelToolbarState } from '../contract/extensions'
import {
  PANEL_TOOLBAR_EVENT,
  PANEL_TOOLBAR_PATH,
  PANEL_VISIBILITY_EVENT,
  type PanelToolbarEvent,
  type PanelVisibility,
} from '../contract/extensionsBridge'
import { watchScrolling } from '../contract/scrollbar'
import { errorMessage, failure } from './results'
import { PANEL_SIZES_PATH, parsePanelSizes, withPanelSize } from './split'

watchScrolling(document)

const params = new URLSearchParams(location.search)
const secret = params.get('t') ?? ''

export const context = {
  workDir: params.get('workDir') ?? '',
  workspaceId: params.get('workspaceId') ?? '',
  locale: params.get('locale') ?? 'en',
}

export async function call(command: string, args?: unknown): Promise<ExtensionResult> {
  try {
    const res = await fetch('/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ostia-panel': secret },
      body: JSON.stringify({ command, args: args ?? {}, context }),
    })
    return (await res.json()) as ExtensionResult
  } catch (err) {
    return failure('unreachable', errorMessage(err))
  }
}

let sizes: Record<string, number> = {}

export async function loadPanelSizes(): Promise<void> {
  try {
    const res = await fetch(PANEL_SIZES_PATH, { headers: { 'x-ostia-panel': secret } })
    if (res.ok) sizes = { ...parsePanelSizes(await res.json()), ...sizes }
  } catch {}
}

export function panelSize(key: string): number | undefined {
  return sizes[key]
}

export function setPanelSize(key: string, fraction: number | null): void {
  sizes = withPanelSize(sizes, key, fraction)
}

export function savePanelSize(key: string, fraction: number | null): void {
  setPanelSize(key, fraction)
  void fetch(PANEL_SIZES_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ostia-panel': secret },
    body: JSON.stringify({ key, fraction }),
  }).catch(() => {})
}

export function onPanelVisibility(cb: (hidden: boolean) => void): void {
  window.addEventListener(PANEL_VISIBILITY_EVENT, (event) => {
    cb((event as CustomEvent<PanelVisibility>).detail?.hidden === true)
  })
  document.addEventListener('visibilitychange', () => cb(document.hidden))
}

export function onChange(cb: () => void): void {
  const events = new EventSource(`/events?t=${encodeURIComponent(secret)}`)
  events.onmessage = () => cb()
  window.addEventListener('focus', cb)
}

export function pickLocale<T>(dicts: { en: T } & Record<string, T>): T {
  return localized(dicts, context.locale)
}

export function panelTranslator(catalogs: LocaleCatalogs): Translate {
  return translatorFor(catalogs, context.locale)
}

type Child = Node | string | null | false | undefined

export function icon(svg: string): Element {
  const el = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  el.setAttribute('width', '1em')
  el.setAttribute('height', '1em')
  el.setAttribute('aria-hidden', 'true')
  return el
}

export function h(
  tag: string,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElement {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value)
    else if (value === true) el.setAttribute(key, '')
    else if (value !== false) el.setAttribute(key, value)
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    el.append(child)
  }
  return el
}

export function errorText(res: ExtensionResult): string {
  if (res.ok) return ''
  return res.message ? `${res.error}: ${res.message}` : res.error
}

export function quietButton(
  label: string,
  onClick: (e: Event) => void,
  strong = false,
): HTMLElement {
  return h('button', { type: 'button', class: strong ? 'quiet strong' : 'quiet', onClick }, label)
}

let sentToolbar = ''

export function setPanelToolbar(state: PanelToolbarState): void {
  const body = JSON.stringify({ workspaceId: context.workspaceId, ...state })
  if (body === sentToolbar) return
  sentToolbar = body
  void fetch(PANEL_TOOLBAR_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ostia-panel': secret },
    body,
  }).catch(() => {
    sentToolbar = ''
  })
}

export function onPanelToolbar(cb: (event: PanelToolbarEvent) => void): void {
  window.addEventListener(PANEL_TOOLBAR_EVENT, (event) => {
    cb((event as CustomEvent<PanelToolbarEvent>).detail)
  })
}

export function emptyState(
  text: string,
  action?: Node,
  attrs: Record<string, string> = {},
): HTMLElement {
  return h('div', { class: 'ostia-empty', ...attrs }, h('p', {}, text), action)
}

export function listRow({
  title,
  meta = [],
  detail = [],
  actions = [],
  attrs = {},
}: {
  title: string
  meta?: Child[]
  detail?: Child[]
  actions?: Node[]
  attrs?: Record<string, string>
}): HTMLElement {
  return h(
    'li',
    { class: 'ostia-row', ...attrs },
    h('div', { class: 'ostia-row-head' }, h('span', { class: 'ostia-row-title' }, title), ...meta),
    ...detail,
    actions.length > 0 ? h('div', { class: 'ostia-row-actions' }, ...actions) : null,
  )
}

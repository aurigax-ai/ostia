import type { ExtensionResult } from '@aurigax-ai/ostia-extension-sdk'
import { emptyState, errorText, h, panelTranslator } from '@aurigax-ai/ostia-extension-sdk/panel'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import type { PanelInstall, PanelScreen } from './panelApi'
import { ViewControl, type ViewTarget } from './viewControl'

interface PanelState {
  install: PanelInstall
  screens: PanelScreen[]
  always: boolean
}

interface RfbView extends ViewTarget {
  scaleViewport: boolean
  disconnect: () => void
  addEventListener: (type: string, listener: () => void) => void
}

type RfbConstructor = new (target: HTMLElement, url: string) => RfbView

interface LiveView {
  id: string
  rfb: RfbView
  control: ViewControl
}

const VIEWER_MODULE = 'novnc/core/rfb.js'
const STATE_POLL_MS = 2000

const t = panelTranslator({ en: en.messages, 'zh-Hant': zhHant.messages })
const p = (key: string, vars?: Record<string, string | number>): string => t(`panel.${key}`, vars)

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('missing #root')
const root: HTMLElement = rootEl
const viewEl = document.getElementById('view')
if (!viewEl) throw new Error('missing #view')
const viewHost: HTMLElement = viewEl

let state: PanelState | null = null
let problem: string | null = null
let busy = false
let live: LiveView | null = null

async function call(command: string, args: unknown = {}): Promise<ExtensionResult> {
  try {
    const res = await fetch('api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command, args }),
    })
    return (await res.json()) as ExtensionResult
  } catch (err) {
    return { ok: false, error: 'unreachable', message: String(err) }
  }
}

async function refresh(): Promise<void> {
  const res = await call('state')
  if (res.ok) {
    state = res.data as PanelState
  } else {
    problem = errorText(res)
  }
  const shown = live && state?.screens.find((s) => s.id === live?.id)
  if (live && !shown) closeView()
  else if (live?.control.holding && shown?.owner === 'agent') live.control.released()
  render()
}

function viewUrl(id: string): string {
  const url = new URL(`view/${encodeURIComponent(id)}`, location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.search = ''
  return url.href
}

function closeView(): void {
  live?.rfb.disconnect()
  live = null
  viewHost.replaceChildren()
}

async function openView(id: string): Promise<void> {
  closeView()
  const module = (await import(new URL(VIEWER_MODULE, location.href).href)) as {
    default: RfbConstructor
  }
  const rfb = new module.default(viewHost, viewUrl(id))
  rfb.scaleViewport = true
  const control = new ViewControl({
    view: rfb,
    active: () => (document.activeElement instanceof HTMLElement ? document.activeElement : null),
    takeover: async () => {
      const res = await call('takeover', { id })
      problem = res.ok ? null : errorText(res)
      return res.ok
    },
    giveback: async () => {
      const res = await call('giveback', { id })
      problem = res.ok ? null : errorText(res)
      return res.ok
    },
  })
  const opened: LiveView = { id, rfb, control }
  rfb.addEventListener('disconnect', () => {
    if (live === opened) closeView()
    render()
  })
  live = opened
  render()
}

async function toggleInput(): Promise<void> {
  if (!live) return
  busy = true
  render()
  const gaveBack = live.control.holding && (await live.control.giveBack())
  if (!gaveBack && !live.control.holding) await live.control.takeOver()
  busy = false
  await refresh()
  if (gaveBack) root.querySelector<HTMLElement>('[data-toggle]')?.focus()
}

async function act(command: string, args?: unknown): Promise<void> {
  busy = true
  render()
  const res = await call(command, args)
  problem = res.ok ? null : errorText(res)
  busy = false
  await refresh()
}

function button(label: string, onClick: () => void, primary = false, toggle = false): HTMLElement {
  return h(
    'button',
    { class: primary ? 'primary' : '', disabled: busy, 'data-toggle': toggle, onclick: onClick },
    label,
  )
}

function installView(install: PanelInstall): HTMLElement[] {
  const parts: HTMLElement[] = []
  if (!install.service) {
    parts.push(
      h(
        'div',
        { class: 'row' },
        h('span', {}, p('missing')),
        button(p('install'), () => void act('install'), true),
      ),
    )
  }
  if (install.outdated) {
    parts.push(
      h(
        'div',
        { class: 'row' },
        h('span', {}, p('outdated', { min: install.minVersion, version: install.version ?? '' })),
        button(p('update'), () => void act('update'), true),
      ),
    )
  }
  if (install.missingPrograms.length > 0) {
    parts.push(
      h(
        'div',
        { class: 'row' },
        h('span', {}, p('missingPrograms', { programs: install.missingPrograms.join(', ') })),
        install.systemInstall ? button(p('installSystem'), () => void act('installSystem')) : null,
      ),
    )
  }
  return parts
}

function screenRow(screen: PanelScreen): HTMLElement {
  const viewing = live?.id === screen.id
  return h(
    'li',
    { class: 'screen' },
    h('span', { class: 'id' }, screen.id),
    h('span', { class: 'muted' }, `${screen.width}x${screen.height}`),
    h('span', { class: 'muted' }, p(`owner.${screen.owner === 'human' ? 'human' : 'agent'}`)),
    screen.agentDriving ? h('span', { class: 'badge' }, p('agentDriving')) : null,
    h('span', { class: 'spacer' }),
    viewing
      ? button(
          live?.control.holding ? p('giveBack') : p('takeOver'),
          () => void toggleInput(),
          true,
          true,
        )
      : button(p('view'), () => void openView(screen.id)),
    button(p('stop'), () => void act('stop', { id: screen.id })),
  )
}

function render(): void {
  if (!state) {
    root.replaceChildren(h('div', { class: 'page muted' }, problem ?? p('loading')))
    return
  }
  const s = state
  root.replaceChildren(
    h(
      'div',
      { class: 'page' },
      h('div', { class: 'alpha' }, p('alpha')),
      ...installView(s.install),
      h(
        'div',
        { class: 'row' },
        h('strong', {}, p('screens')),
        h('span', { class: 'spacer' }),
        s.install.service ? button(p('new'), () => void act('create'), true) : null,
      ),
      s.screens.length === 0
        ? emptyState(p('none'))
        : h('ul', { class: 'screens' }, ...s.screens.map(screenRow)),
      s.always
        ? h(
            'div',
            { class: 'row' },
            h('span', {}, p('always')),
            button(p('revoke'), () => void act('revoke')),
          )
        : null,
      live
        ? h('div', { class: 'muted' }, live.control.holding ? p('youHold') : p('viewOnly'))
        : null,
      problem ? h('div', { class: 'error' }, problem) : null,
    ),
  )
}

const events = new EventSource('events')
events.onmessage = () => void refresh()
window.addEventListener('focus', () => void refresh())
setInterval(() => {
  if (state?.screens.length) void refresh()
}, STATE_POLL_MS)
render()
void refresh()

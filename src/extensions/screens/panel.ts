import type { ExtensionResult } from '@aurigax-ai/ostia-extension-sdk'
import {
  emptyState,
  errorText,
  h,
  onPanelVisibility,
  panelTranslator,
} from '@aurigax-ai/ostia-extension-sdk/panel'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import type { PanelInstall, PanelPhones, PanelScreen } from './panelApi'
import { ViewControl, type ViewTarget } from './viewControl'

interface PanelState {
  install: PanelInstall
  screens: PanelScreen[]
  always: boolean
  phones: PanelPhones
}

interface PhoneWatch {
  id: string
  img: HTMLImageElement
  timer: ReturnType<typeof setInterval>
  seq: number
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
const FRAME_POLL_MS = 500
const MINUTE_MS = 60_000

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
let watching: PhoneWatch | null = null

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
  if (watching && !state?.screens.some((s) => s.id === watching?.id)) closeWatch()
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

function closeWatch(): void {
  if (!watching) return
  clearInterval(watching.timer)
  watching = null
  viewHost.replaceChildren()
}

async function pollFrame(): Promise<void> {
  const shown = watching
  if (!shown) return
  const res = await call('frame', { id: shown.id })
  const frame = res.ok ? (res.data as { seq: number; jpeg: string } | null) : null
  if (watching !== shown || !frame || frame.seq === shown.seq) return
  shown.seq = frame.seq
  shown.img.src = `data:image/jpeg;base64,${frame.jpeg}`
}

async function stopWatch(): Promise<void> {
  if (!watching) return
  const id = watching.id
  closeWatch()
  render()
  await call('watch', { id, on: false })
}

async function toggleWatch(id: string): Promise<void> {
  const stopping = watching?.id === id
  if (watching) {
    const was = watching.id
    closeWatch()
    await call('watch', { id: was, on: false })
  }
  if (!stopping) {
    closeView()
    const res = await call('watch', { id, on: true })
    problem = res.ok ? null : errorText(res)
    if (res.ok) {
      const img = h('img', { alt: '' }) as HTMLImageElement
      viewHost.replaceChildren(img)
      watching = { id, img, seq: -1, timer: setInterval(() => void pollFrame(), FRAME_POLL_MS) }
    }
  }
  render()
}

async function openView(id: string): Promise<void> {
  closeView()
  closeWatch()
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

function phoneRow(screen: PanelScreen): HTMLElement | null {
  const phone = screen.phone
  if (!phone) return null
  const minutes = Math.max(0, Math.ceil((phone.endsAt - Date.now()) / MINUTE_MS))
  const shown = watching?.id === screen.id
  return h(
    'li',
    { class: 'screen' },
    h('span', {}, phone.device),
    h('span', { class: 'badge' }, p('phoneBadge')),
    h('span', { class: 'muted' }, p(`level.${phone.level}`)),
    h('span', { class: 'muted' }, p('minutesLeft', { minutes })),
    phone.state === 'paused'
      ? h('span', { class: 'muted', title: p('pausedHint') }, p('paused'))
      : phone.foreground
        ? h('span', { class: 'muted' }, phone.foreground)
        : null,
    h('span', { class: 'ostia-spacer' }),
    button(shown ? p('watching') : p('watch'), () => void toggleWatch(screen.id), shown),
    button(p('stop'), () => void act('stop', { id: screen.id })),
  )
}

function askRow(phones: PanelPhones): HTMLElement | null {
  if (!phones.listening) return null
  return h(
    'div',
    { class: 'row' },
    h('span', { class: 'muted' }, phones.asked ? p('asked') : p('askHint')),
    h('span', { class: 'ostia-spacer' }),
    h('button', { disabled: busy || phones.asked, onclick: () => void act('ask') }, p('ask')),
  )
}

function screenRow(screen: PanelScreen): HTMLElement {
  const phone = phoneRow(screen)
  if (phone) return phone
  const viewing = live?.id === screen.id
  return h(
    'li',
    { class: 'screen' },
    h('span', { class: 'id' }, screen.id),
    h('span', { class: 'muted' }, `${screen.width}x${screen.height}`),
    h('span', { class: 'muted' }, p(`owner.${screen.owner === 'human' ? 'human' : 'agent'}`)),
    screen.agentDriving ? h('span', { class: 'badge' }, p('agentDriving')) : null,
    h('span', { class: 'ostia-spacer' }),
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
      { class: 'list' },
      h('div', { class: 'alpha' }, p('alpha')),
      ...installView(s.install),
      h(
        'div',
        { class: 'row' },
        h('strong', {}, p('screens')),
        h('span', { class: 'ostia-spacer' }),
        s.install.service ? button(p('new'), () => void act('create'), true) : null,
      ),
      s.screens.length === 0
        ? emptyState(p('none'))
        : h('ul', { class: 'screens' }, ...s.screens.map(screenRow)),
      askRow(s.phones),
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
      watching ? h('div', { class: 'muted' }, p('watchOnly')) : null,
      problem ? h('div', { class: 'error' }, problem) : null,
    ),
  )
}

onPanelVisibility((hidden) => {
  if (hidden) void stopWatch()
})

const events = new EventSource('events')
events.onmessage = () => void refresh()
window.addEventListener('focus', () => void refresh())
setInterval(() => {
  if (state?.screens.length) void refresh()
}, STATE_POLL_MS)
render()
void refresh()

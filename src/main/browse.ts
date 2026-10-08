import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { webContents } from 'electron'
import {
  DEFAULT_SCROLL_PX,
  type KeyCombo,
  globMatches,
  isScrollDirection,
  normalizeUrl,
  parseKeyCombo,
  scrollDelta,
} from '../shared/browseInput'
import { type NetworkFilter, filterRequests, summarizeRequest } from '../shared/browseNetwork'
import type {
  BrowseOutcome,
  ElementState,
  FindQuery,
  StorageArea,
  WebStorageDump,
} from '../shared/browseRuntime'
import { type SnapshotNode, formatSnapshot } from '../shared/browseSnapshot'
import type { StorageCookie } from '../shared/browserStorage'
import { PRODUCT_NAME } from '../shared/product'
import { PRODUCT_DISPLAY_NAME } from '../shared/productDisplay'
import type { CommandResult, CommandTarget } from '../shared/types'
import { jsArgs, runInBrowseWorld } from './browseWorld'
import { clearStorage, listCookies, readWebStorage, writeCookie } from './browserStorage'
import type { AuthedConn } from './controlAuth'
import { ensureCaps } from './controlElevation'
import { registerTargetableMethod } from './controlServer'
import {
  type PausedReply,
  type PausedRequest,
  clearRequestLog,
  networkIdleFor,
  requestsFor,
  setGuestRoutes,
} from './guestNetwork'
import { type PaneIdentity, getByPaneId, resolveExternal } from './idRegistry'
import { resolveSafe } from './pathGuard'
import { privateTmpDir } from './privateTmp'
import type { Reach } from './reach'

type MethodCtx = { identity: PaneIdentity; authed: AuthedConn }

export interface BrowseDeps {
  browserPanes: Map<string, number>
  isSharedPane: (paneId: string) => boolean
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  screenshotRoots: string[]
  consoleBuffers: Map<number, ConsoleEntry[]>
  errorBuffers: Map<number, ConsoleEntry[]>
  allowNavigation?: (workspaceId: string, url: string) => Promise<boolean>
  reach: Pick<Reach, 'inScope'>
}

export interface ConsoleEntry {
  level: string
  text: string
  ts: number
}

export const MAX_CONSOLE_ENTRIES = 500
export const DEFAULT_TIMEOUT_MS = 25_000
export const MAX_TIMEOUT_MS = 120_000
const POLL_MS = 100
const NETWORK_IDLE_MS = 500
const NEW_TAB_WAIT_MS = 10_000
const INPUT_SETTLE_MS = 30
const NEW_TAB_URL = /^(https?|file):/i

export function pushConsoleEntry(
  buffer: Map<number, ConsoleEntry[]>,
  wcId: number,
  entry: ConsoleEntry,
): void {
  const list = buffer.get(wcId) ?? []
  list.push(entry)
  if (list.length > MAX_CONSOLE_ENTRIES) list.splice(0, list.length - MAX_CONSOLE_ENTRIES)
  buffer.set(wcId, list)
}

export const OSTIA_ERROR_PREFIX = '[ostia-error]'

export const PAGE_ERROR_CATCHER_JS = `(() => {
  if (window.__ostiaErrCatcher) return;
  window.__ostiaErrCatcher = true;
  window.onerror = function (message, source, lineno, colno, error) {
    console.error('${OSTIA_ERROR_PREFIX}', error && error.stack ? error.stack : message);
  };
  window.onunhandledrejection = function (event) {
    var reason = event && event.reason;
    console.error('${OSTIA_ERROR_PREFIX}', reason && reason.stack ? reason.stack : String(reason));
  };
})();`

interface Route {
  pattern: string
  abort: boolean
  body?: string
}

const dialogPolicies = new Map<number, { policy: 'accept' | 'dismiss'; text: string | null }>()
const dialogInitAttached = new Set<number>()
const reactGrabOn = new Set<number>()
const mousePositions = new Map<number, { x: number; y: number }>()
const guestRoutes = new Map<number, Route[]>()
const activeTabs = new Map<string, string>()

export function clearGuestBrowseState(wcId: number): void {
  dialogPolicies.delete(wcId)
  dialogInitAttached.delete(wcId)
  reactGrabOn.delete(wcId)
  mousePositions.delete(wcId)
  guestRoutes.delete(wcId)
}

const MAX_DIALOG_ENTRIES = 200

const DIALOG_OVERRIDE_JS = `(() => {
  if (window.__ostiaDialogPatched) return;
  window.__ostiaDialogPatched = true;
  window.__ostiaDialogs = window.__ostiaDialogs || [];
  window.__ostiaDialogPolicy = window.__ostiaDialogPolicy || { policy: 'dismiss', text: null };
  function log(type, message) {
    window.__ostiaDialogs.push({ type: type, message: String(message), ts: Date.now() });
    if (window.__ostiaDialogs.length > ${MAX_DIALOG_ENTRIES}) {
      window.__ostiaDialogs.splice(0, window.__ostiaDialogs.length - ${MAX_DIALOG_ENTRIES});
    }
  }
  window.alert = function (message) {
    log('alert', message);
  };
  window.confirm = function (message) {
    log('confirm', message);
    return window.__ostiaDialogPolicy.policy === 'accept';
  };
  window.prompt = function (message) {
    log('prompt', message);
    return window.__ostiaDialogPolicy.policy === 'accept' ? (window.__ostiaDialogPolicy.text || '') : null;
  };
})();`

const REACT_GRAB_ON_JS = `(() => {
  if (window.__ostiaReactGrabOn) return true;
  window.__ostiaReactGrabOn = true;
  window.__ostiaReactGrab = window.__ostiaReactGrab || null;
  function findFiber(el) {
    for (const key in el) {
      if (key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0) {
        return el[key];
      }
    }
    return null;
  }
  window.__ostiaReactGrabHandler = function (e) {
    let el = e.target;
    let fiber = null;
    while (el && !fiber) {
      fiber = findFiber(el);
      if (!fiber) el = el.parentElement;
    }
    if (!fiber) {
      window.__ostiaReactGrab = { component: null, file: null, line: null };
      return;
    }
    let f = fiber;
    let component = null;
    let source = null;
    while (f) {
      if (typeof f.type === 'function') {
        component = f.type.displayName || f.type.name || 'Anonymous';
        source = f._debugSource || null;
        break;
      }
      f = f.return;
    }
    window.__ostiaReactGrab = {
      component: component,
      file: source ? source.fileName : null,
      line: source ? source.lineNumber : null,
    };
  };
  document.addEventListener('click', window.__ostiaReactGrabHandler, true);
  return true;
})();`

const REACT_GRAB_OFF_JS = `(() => {
  if (!window.__ostiaReactGrabOn) return true;
  window.__ostiaReactGrabOn = false;
  if (window.__ostiaReactGrabHandler) {
    document.removeEventListener('click', window.__ostiaReactGrabHandler, true);
  }
  return true;
})();`

type GuestResolution =
  | { ok: true; guest: Electron.WebContents; rendererPaneId: string }
  | { ok: false; error: 'no-browser-pane' }
  | { ok: false; error: 'browser-not-ready' }
  | { ok: false; error: 'needs-elevation' }

function liveGuest(wcId: number | undefined): Electron.WebContents | null {
  if (wcId === undefined) return null
  const guest = webContents.fromId(wcId)
  return guest && !guest.isDestroyed() ? guest : null
}

export const SHARED_PROFILE_DETAIL =
  "act in the human's signed-in browser: this tab uses their own browser profile, with their cookies, logins and open sessions"

type GuestDeps = Pick<BrowseDeps, 'browserPanes' | 'isSharedPane' | 'reach'>

async function elevate(
  ctx: MethodCtx,
  cap: 'all-workspaces' | 'credentials',
  detail: string,
): Promise<GuestResolution | null> {
  try {
    await ensureCaps(ctx.authed, ctx.identity, [cap], 'browse', detail)
    return null
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('needs-elevation')) {
      return { ok: false, error: 'needs-elevation' }
    }
    throw e
  }
}

function sharedDetail(tabId: string): string {
  return `${SHARED_PROFILE_DETAIL} (tab ${tabId})`
}

export function defaultBrowserPane(deps: GuestDeps, ctx: MethodCtx): string | undefined {
  const active = activeTabs.get(ctx.identity.paneId)
  if (active && getByPaneId(active)?.workspaceId === ctx.identity.workspaceId) {
    if (liveGuest(deps.browserPanes.get(active))) return active
  }
  for (const [rendererPaneId, wcId] of deps.browserPanes) {
    if (getByPaneId(rendererPaneId)?.workspaceId !== ctx.identity.workspaceId) continue
    if (deps.isSharedPane(rendererPaneId)) continue
    if (liveGuest(wcId)) return rendererPaneId
  }
  return undefined
}

export async function resolveGuest(
  deps: GuestDeps,
  ctx: MethodCtx,
  paneId?: string,
): Promise<GuestResolution> {
  if (paneId) {
    const identity = resolveExternal(paneId)
    if (!identity) return { ok: false, error: 'no-browser-pane' }
    const wcId = deps.browserPanes.get(identity.paneId)
    if (wcId === undefined) return { ok: false, error: 'browser-not-ready' }
    if (!(await deps.reach.inScope(ctx, identity.workspaceId))) {
      const refused = await elevate(ctx, 'all-workspaces', `pane ${paneId}`)
      if (refused) return refused
    }
    if (deps.isSharedPane(identity.paneId)) {
      const refused = await elevate(ctx, 'credentials', sharedDetail(paneId))
      if (refused) return refused
    }
    const guest = liveGuest(wcId)
    if (!guest) return { ok: false, error: 'browser-not-ready' }
    return { ok: true, guest, rendererPaneId: identity.paneId }
  }
  const rendererPaneId = defaultBrowserPane(deps, ctx)
  const guest = rendererPaneId ? liveGuest(deps.browserPanes.get(rendererPaneId)) : null
  if (!rendererPaneId || !guest) return { ok: false, error: 'no-browser-pane' }
  if (deps.isSharedPane(rendererPaneId)) {
    const tabId = getByPaneId(rendererPaneId)?.externalId ?? rendererPaneId
    const refused = await elevate(ctx, 'credentials', sharedDetail(tabId))
    if (refused) return refused
  }
  return { ok: true, guest, rendererPaneId }
}

export function ownedGuest(
  browserPanes: Map<string, number>,
  paneId: string,
  senderWindowId: string,
): Electron.WebContents | null {
  if (typeof paneId !== 'string' || getByPaneId(paneId)?.windowId !== senderWindowId) return null
  return liveGuest(browserPanes.get(paneId))
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function fail(error: string, message?: string): { ok: false; error: string; message?: string } {
  return message ? { ok: false, error, message } : { ok: false, error }
}

type Params = Record<string, unknown>

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clampTimeout(value: unknown): number {
  const ms = num(value) ?? DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(ms, 0), MAX_TIMEOUT_MS)
}

function world<T extends object>(
  guest: Electron.WebContents,
  call: string,
): Promise<BrowseOutcome<T>> {
  return runInBrowseWorld<BrowseOutcome<T>>(guest, call)
}

async function debuggerCommand<T = unknown>(
  guest: Electron.WebContents,
  method: string,
  params?: object,
): Promise<T> {
  if (!guest.debugger.isAttached()) guest.debugger.attach('1.3')
  return (await guest.debugger.sendCommand(method, params)) as T
}

async function settle(guest: Electron.WebContents): Promise<void> {
  await sleep(INPUT_SETTLE_MS)
  try {
    await guest.executeJavaScript('0', false)
  } catch {}
}

function zoomed(guest: Electron.WebContents, x: number, y: number): { x: number; y: number } {
  const zoom = guest.getZoomFactor()
  return { x: Math.round(x * zoom), y: Math.round(y * zoom) }
}

type MouseButton = 'left' | 'right' | 'middle'

function mouseMove(guest: Electron.WebContents, x: number, y: number): void {
  const at = zoomed(guest, x, y)
  guest.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
  mousePositions.set(guest.id, { x, y })
}

function mouseButton(
  guest: Electron.WebContents,
  type: 'mouseDown' | 'mouseUp',
  button: MouseButton,
  clickCount: number,
): void {
  const pos = mousePositions.get(guest.id) ?? { x: 0, y: 0 }
  const at = zoomed(guest, pos.x, pos.y)
  guest.sendInputEvent({ type, x: at.x, y: at.y, button, clickCount })
}

async function clickPoint(
  guest: Electron.WebContents,
  x: number,
  y: number,
  clicks: number,
): Promise<void> {
  mouseMove(guest, x, y)
  for (let n = 1; n <= clicks; n++) {
    mouseButton(guest, 'mouseDown', 'left', n)
    mouseButton(guest, 'mouseUp', 'left', n)
  }
  await settle(guest)
}

function sendCombo(guest: Electron.WebContents, combo: KeyCombo, phase: 'down' | 'up' | 'press') {
  if (phase !== 'up') {
    guest.sendInputEvent({ type: 'keyDown', keyCode: combo.keyCode, modifiers: combo.modifiers })
    if (combo.printable) {
      guest.sendInputEvent({ type: 'char', keyCode: combo.keyCode, modifiers: combo.modifiers })
    }
  }
  if (phase !== 'down') {
    guest.sendInputEvent({ type: 'keyUp', keyCode: combo.keyCode, modifiers: combo.modifiers })
  }
}

const TYPEABLE_KEY = /^[\x21-\x7e]$/

function typeText(guest: Electron.WebContents, text: string): void {
  for (const ch of text) {
    if (ch === '\n') {
      sendCombo(guest, { keyCode: 'Return', modifiers: [], printable: false }, 'press')
      continue
    }
    const keyCode = ch === ' ' ? 'Space' : ch
    const hasKey = ch === ' ' || TYPEABLE_KEY.test(ch)
    if (hasKey) guest.sendInputEvent({ type: 'keyDown', keyCode })
    guest.sendInputEvent({ type: 'char', keyCode: ch })
    if (hasKey) guest.sendInputEvent({ type: 'keyUp', keyCode })
  }
}

async function clickTarget(
  guest: Electron.WebContents,
  target: string,
  clicks: number,
): Promise<BrowseOutcome> {
  const at = await world<{ x: number; y: number }>(guest, `point(${jsArgs(target)})`)
  if (!at.ok) return at
  await clickPoint(guest, at.x, at.y, clicks)
  return { ok: true }
}

async function setChecked(
  guest: Electron.WebContents,
  target: string,
  wanted: boolean,
): Promise<BrowseOutcome> {
  const state = await world<{ value: boolean }>(guest, `checked(${jsArgs(target)})`)
  if (!state.ok) return state
  if (state.value === wanted) return { ok: true }
  const clicked = await clickTarget(guest, target, 1)
  if (!clicked.ok) return clicked
  const after = await world<{ value: boolean }>(guest, `checked(${jsArgs(target)})`)
  if (!after.ok) return after
  return after.value === wanted ? { ok: true } : fail('state-unchanged', target)
}

function commandTarget(identity: PaneIdentity): CommandTarget {
  return { windowId: identity.windowId, workspaceId: identity.workspaceId, paneId: identity.paneId }
}

function tabEntry(rendererPaneId: string, guest: Electron.WebContents, activeId?: string) {
  return {
    tabId: getByPaneId(rendererPaneId)?.externalId ?? rendererPaneId,
    url: guest.getURL(),
    title: guest.getTitle(),
    active: rendererPaneId === activeId,
  }
}

function sharedTabEntry(rendererPaneId: string, activeId?: string) {
  return {
    tabId: getByPaneId(rendererPaneId)?.externalId ?? rendererPaneId,
    profile: 'shared' as const,
    active: rendererPaneId === activeId,
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await check()) return true
    } catch {}
    if (Date.now() >= deadline) return false
    await sleep(POLL_MS)
  }
}

function safeOutPath(deps: BrowseDeps, path: string): string | null {
  return resolveSafe(path, deps.screenshotRoots)
}

let scratchCounter = 0

function scratchPath(prefix: string, ext: string): string {
  scratchCounter += 1
  return join(
    privateTmpDir(`${PRODUCT_NAME}-screens`),
    `${prefix}-${Date.now()}-${scratchCounter}.${ext}`,
  )
}

function writeOut(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
}

function jsonContentType(body: string): string {
  try {
    JSON.parse(body)
    return 'application/json'
  } catch {
    return 'text/plain'
  }
}

function routeReply(wcId: number, paused: PausedRequest): PausedReply | null {
  const route = [...(guestRoutes.get(wcId) ?? [])]
    .reverse()
    .find((r) => globMatches(r.pattern, paused.request.url))
  if (!route) return null
  if (route.abort) {
    return {
      method: 'Fetch.failRequest',
      params: { requestId: paused.requestId, errorReason: 'BlockedByClient' },
    }
  }
  if (route.body === undefined) return null
  return {
    method: 'Fetch.fulfillRequest',
    params: {
      requestId: paused.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: jsonContentType(route.body) }],
      body: Buffer.from(route.body).toString('base64'),
    },
  }
}

async function applyRoutes(guest: Electron.WebContents): Promise<void> {
  const routes = guestRoutes.get(guest.id) ?? []
  const wcId = guest.id
  if (!guest.debugger.isAttached()) guest.debugger.attach('1.3')
  await setGuestRoutes(
    guest,
    routes.map((r) => r.pattern),
    routes.length === 0 ? null : (paused) => routeReply(wcId, paused),
  )
}

async function addInitScript(
  guest: Electron.WebContents,
  source: string,
): Promise<{ ok: true; identifier: string }> {
  await debuggerCommand(guest, 'Page.enable')
  const result = await debuggerCommand<{ identifier: string }>(
    guest,
    'Page.addScriptToEvaluateOnNewDocument',
    { source },
  )
  return { ok: true, identifier: result.identifier }
}

interface StateFile {
  cookies: StorageCookie[]
  localStorage: Record<string, string>
  sessionStorage: Record<string, string>
}

export function registerBrowseMethods(deps: BrowseDeps): void {
  const method = (
    name: string,
    run: (
      guest: Electron.WebContents,
      p: Params,
      ctx: MethodCtx,
      rendererPaneId: string,
    ) => unknown | Promise<unknown>,
  ): void => {
    registerTargetableMethod(`browse.${name}`, {
      cap: 'browse',
      handler: async (params, ctx) => {
        const p = (params ?? {}) as Params
        const resolution = await resolveGuest(deps, ctx, str(p.paneId))
        if (!resolution.ok) return resolution
        try {
          return await run(resolution.guest, p, ctx, resolution.rendererPaneId)
        } catch (e) {
          return fail('failed', errMessage(e))
        }
      },
    })
  }

  const workspaceBrowsers = (workspaceId: string): Set<string> => {
    const ids = new Set<string>()
    for (const paneId of deps.browserPanes.keys()) {
      if (getByPaneId(paneId)?.workspaceId === workspaceId) ids.add(paneId)
    }
    return ids
  }

  const openTab = async (ctx: MethodCtx, url: string, background: boolean) => {
    const before = workspaceBrowsers(ctx.identity.workspaceId)
    const res = await deps.execCommand(commandTarget(ctx.identity), 'browser.new', {
      url,
      ...(background ? { background: true } : {}),
    })
    if (!res.ok) return fail('browser-not-ready', res.error.message)
    let created: string | undefined
    await waitFor(async () => {
      created = [...workspaceBrowsers(ctx.identity.workspaceId)].find((id) => !before.has(id))
      return created !== undefined
    }, NEW_TAB_WAIT_MS)
    if (!created) return { ok: true, created: true }
    activeTabs.set(ctx.identity.paneId, created)
    return { ok: true, created: true, tabId: getByPaneId(created)?.externalId, url }
  }

  registerTargetableMethod('browse.open', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const p = (params ?? {}) as Params
      const raw = str(p.url)
      const url = raw ? normalizeUrl(raw) : undefined
      if (
        url &&
        deps.allowNavigation &&
        !(await deps.allowNavigation(ctx.identity.workspaceId, url))
      ) {
        return { ok: false, error: 'sandboxed', message: `the sandbox does not allow ${url}` }
      }
      const resolution = await resolveGuest(deps, ctx, str(p.paneId))
      if (resolution.ok) {
        if (url) await resolution.guest.loadURL(url).catch(() => {})
        return {
          ok: true,
          tabId: getByPaneId(resolution.rendererPaneId)?.externalId,
          url: resolution.guest.getURL(),
          title: resolution.guest.getTitle(),
        }
      }
      if (resolution.error !== 'no-browser-pane' || p.paneId) return resolution
      return openTab(ctx, url ?? 'about:blank', p.background === true)
    },
  })

  method('back', (guest) => {
    guest.navigationHistory.goBack()
    return { ok: true }
  })
  method('forward', (guest) => {
    guest.navigationHistory.goForward()
    return { ok: true }
  })
  method('reload', (guest) => {
    guest.reload()
    return { ok: true }
  })

  method('close', async (_guest, _p, ctx, rendererPaneId) => {
    const identity = getByPaneId(rendererPaneId)
    if (!identity) return fail('no-browser-pane')
    const res = await deps.execCommand(commandTarget(identity), 'pane.close', {
      paneId: identity.paneId,
    })
    if (!res.ok) return fail('command-failed', res.error.message)
    if (activeTabs.get(ctx.identity.paneId) === rendererPaneId)
      activeTabs.delete(ctx.identity.paneId)
    return { ok: true }
  })

  method('read', async (guest) => {
    const text = await runInBrowseWorld<string>(guest, 'readText()')
    return { ok: true, text, url: guest.getURL(), title: guest.getTitle() }
  })

  method('click', async (guest, p, ctx) => {
    const target = str(p.target) ?? ''
    if (p.newTab === true) {
      const link = await world<{ url: string }>(guest, `href(${jsArgs(target)})`)
      if (!link.ok) return link
      if (!NEW_TAB_URL.test(link.url)) return fail('unsupported-url', link.url)
      return openTab(ctx, link.url, false)
    }
    return clickTarget(guest, target, 1)
  })

  method('dblclick', (guest, p) => clickTarget(guest, str(p.target) ?? '', 2))

  method('hover', async (guest, p) => {
    const at = await world<{ x: number; y: number }>(guest, `point(${jsArgs(str(p.target))})`)
    if (!at.ok) return at
    mouseMove(guest, at.x, at.y)
    await settle(guest)
    return { ok: true }
  })

  method('focus', (guest, p) => world(guest, `focus(${jsArgs(str(p.target))})`))

  method('fill', (guest, p) => world(guest, `fill(${jsArgs(str(p.target), str(p.text) ?? '')})`))

  method('type', async (guest, p) => {
    const focused = await world(guest, `focus(${jsArgs(str(p.target))})`)
    if (!focused.ok) return focused
    typeText(guest, str(p.text) ?? '')
    await settle(guest)
    return { ok: true }
  })

  method('keyboard', async (guest, p) => {
    const text = str(p.text) ?? ''
    if (p.mode === 'inserttext') guest.insertText(text)
    else if (p.mode === 'type') typeText(guest, text)
    else return fail('bad-sub', String(p.mode))
    await settle(guest)
    return { ok: true }
  })

  const keyMethod = (name: string, phase: 'down' | 'up' | 'press'): void => {
    method(name, async (guest, p) => {
      const combo = parseKeyCombo(str(p.key) ?? '')
      if (!combo) return fail('bad-key', str(p.key))
      sendCombo(guest, combo, phase)
      await settle(guest)
      return { ok: true }
    })
  }
  keyMethod('press', 'press')
  keyMethod('keydown', 'down')
  keyMethod('keyup', 'up')

  method('select', (guest, p) => {
    const values = Array.isArray(p.values) ? p.values.filter((v) => typeof v === 'string') : []
    if (values.length === 0) return fail('value-required')
    return world(guest, `select(${jsArgs(str(p.target), values)})`)
  })

  method('check', (guest, p) => setChecked(guest, str(p.target) ?? '', true))
  method('uncheck', (guest, p) => setChecked(guest, str(p.target) ?? '', false))

  method('scroll', (guest, p) => {
    const direction = p.direction ?? 'down'
    if (!isScrollDirection(direction)) return fail('bad-direction', String(direction))
    const { dx, dy } = scrollDelta(direction, num(p.amount) ?? DEFAULT_SCROLL_PX)
    return world(guest, `scroll(${jsArgs(str(p.target) ?? null, dx, dy)})`)
  })

  method('scrollintoview', (guest, p) => world(guest, `scrollIntoView(${jsArgs(str(p.target))})`))

  method('drag', async (guest, p) => {
    const from = await world<{ x: number; y: number }>(guest, `point(${jsArgs(str(p.source))})`)
    if (!from.ok) return from
    const to = await world<{ x: number; y: number }>(guest, `point(${jsArgs(str(p.target))})`)
    if (!to.ok) return to
    mouseMove(guest, from.x, from.y)
    mouseButton(guest, 'mouseDown', 'left', 1)
    const steps = 10
    for (let i = 1; i <= steps; i++) {
      mouseMove(
        guest,
        from.x + ((to.x - from.x) * i) / steps,
        from.y + ((to.y - from.y) * i) / steps,
      )
      await sleep(10)
    }
    mouseButton(guest, 'mouseUp', 'left', 1)
    await settle(guest)
    return { ok: true }
  })

  method('upload', async (guest, p) => {
    const files = Array.isArray(p.files) ? p.files.filter((f) => typeof f === 'string') : []
    if (files.length === 0) return fail('files-required')
    const safe: string[] = []
    for (const file of files) {
      const path = safeOutPath(deps, file)
      if (!path) return fail('path-denied', file)
      if (!existsSync(path)) return fail('file-not-found', file)
      safe.push(path)
    }
    const nonce = randomUUID()
    const marked = await world(guest, `mark(${jsArgs(str(p.target), nonce)})`)
    if (!marked.ok) return marked
    try {
      await debuggerCommand(guest, 'DOM.getDocument', { depth: 0 })
      const search = await debuggerCommand<{ searchId: string; resultCount: number }>(
        guest,
        'DOM.performSearch',
        { query: `[data-ostia-mark="${nonce}"]` },
      )
      const found = await debuggerCommand<{ nodeIds: number[] }>(guest, 'DOM.getSearchResults', {
        searchId: search.searchId,
        fromIndex: 0,
        toIndex: search.resultCount,
      })
      await debuggerCommand(guest, 'DOM.discardSearchResults', { searchId: search.searchId })
      const nodeId = found.nodeIds[0]
      if (nodeId === undefined) return fail('not-found', str(p.target))
      await debuggerCommand(guest, 'DOM.setFileInputFiles', { files: safe, nodeId })
      return { ok: true, files: safe }
    } finally {
      await runInBrowseWorld(guest, `unmark(${jsArgs(nonce)})`).catch(() => {})
    }
  })

  method('screenshot', async (guest, p, _ctx, rendererPaneId) => {
    const requested = str(p.path)
    const outPath = requested ? safeOutPath(deps, requested) : scratchPath(rendererPaneId, 'png')
    if (!outPath) return fail('path-denied', requested)
    if (p.full === true) {
      const metrics = await debuggerCommand<{ cssContentSize: { width: number; height: number } }>(
        guest,
        'Page.getLayoutMetrics',
      )
      const shot = await debuggerCommand<{ data: string }>(guest, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: Math.ceil(metrics.cssContentSize.width),
          height: Math.ceil(metrics.cssContentSize.height),
          scale: 1,
        },
      })
      writeOut(outPath, Buffer.from(shot.data, 'base64'))
    } else {
      const image = await guest.capturePage()
      writeOut(outPath, image.toPNG())
    }
    return { ok: true, path: outPath }
  })

  method('pdf', async (guest, p) => {
    const requested = str(p.path)
    if (!requested) return fail('path-required')
    const outPath = safeOutPath(deps, requested)
    if (!outPath) return fail('path-denied', requested)
    writeOut(outPath, await guest.printToPDF({}))
    return { ok: true, path: outPath }
  })

  method('snapshot', async (guest, p) => {
    const result = await world<{ tree: SnapshotNode[] }>(
      guest,
      `snapshot(${jsArgs(str(p.selector) ?? null)})`,
    )
    if (!result.ok) return result
    const { snapshot, refs } = formatSnapshot(result.tree, {
      interactive: p.interactive === true,
      compact: p.compact === true,
      depth: num(p.depth),
      urls: p.urls === true,
    })
    return { ok: true, snapshot, refs, url: guest.getURL(), title: guest.getTitle() }
  })

  method('eval', async (guest, p) => {
    const js = str(p.js)
    if (!js) return fail('js-required')
    const result = await guest.executeJavaScript(js, true)
    return { ok: true, result: result === undefined ? null : result }
  })

  method('get', (guest, p) => {
    const sub = str(p.sub) ?? ''
    if (sub === 'cdp-url')
      return fail('unsupported', `${PRODUCT_DISPLAY_NAME} drives its own browser panes`)
    return world(guest, `get(${jsArgs(sub, str(p.target) ?? null, str(p.arg) ?? null)})`)
  })

  method('is', (guest, p) => world(guest, `is(${jsArgs(str(p.sub), str(p.target))})`))

  method('find', async (guest, p) => {
    const query: FindQuery = {
      by: str(p.by) ?? '',
      value: str(p.value) ?? '',
      name: str(p.name),
      exact: p.exact === true,
      index: num(p.index),
    }
    const found = await world<{ ref: string }>(guest, `find(${jsArgs(query)})`)
    if (!found.ok) return found
    const ref = `@${found.ref}`
    const action = str(p.action) ?? 'click'
    const text = str(p.text) ?? ''
    switch (action) {
      case 'click':
        return withRef(ref, await clickTarget(guest, ref, 1))
      case 'fill':
        return withRef(ref, await world(guest, `fill(${jsArgs(ref, text)})`))
      case 'type': {
        const focused = await world(guest, `focus(${jsArgs(ref)})`)
        if (!focused.ok) return focused
        typeText(guest, text)
        await settle(guest)
        return { ok: true, ref }
      }
      case 'check':
        return withRef(ref, await setChecked(guest, ref, true))
      case 'uncheck':
        return withRef(ref, await setChecked(guest, ref, false))
      case 'hover': {
        const at = await world<{ x: number; y: number }>(guest, `point(${jsArgs(ref)})`)
        if (!at.ok) return at
        mouseMove(guest, at.x, at.y)
        await settle(guest)
        return { ok: true, ref }
      }
      case 'text': {
        const got = await world<{ value: unknown }>(guest, `get(${jsArgs('text', ref, null)})`)
        return got.ok ? { ok: true, ref, value: got.value } : got
      }
      default:
        return fail('bad-action', action)
    }
  })

  method('wait', async (guest, p) => {
    const timeoutMs = clampTimeout(p.timeoutMs)
    if (num(p.ms) !== undefined) {
      await sleep(Math.min(num(p.ms) ?? 0, MAX_TIMEOUT_MS))
      return { ok: true }
    }
    let check: () => Promise<boolean>
    const target = str(p.target)
    const text = str(p.text)
    const url = str(p.url)
    const load = str(p.load)
    const fn = str(p.fn)
    if (target) {
      const state = (str(p.state) ?? 'visible') as ElementState
      if (!['visible', 'hidden', 'attached', 'detached'].includes(state)) {
        return fail('bad-state', state)
      }
      check = () => runInBrowseWorld<boolean>(guest, `hasState(${jsArgs(target, state)})`)
    } else if (text !== undefined) {
      check = () => runInBrowseWorld<boolean>(guest, `hasText(${jsArgs(text)})`)
    } else if (url !== undefined) {
      check = async () => globMatches(url, guest.getURL())
    } else if (load !== undefined) {
      if (!['load', 'domcontentloaded', 'networkidle'].includes(load)) {
        return fail('bad-load-state', load)
      }
      check = async () => {
        const ready = await runInBrowseWorld<string>(guest, 'readyState()')
        if (load === 'domcontentloaded') return ready !== 'loading'
        if (ready !== 'complete' || guest.isLoading()) return false
        return load === 'load' || networkIdleFor(guest.id, Date.now(), NETWORK_IDLE_MS)
      }
    } else if (fn !== undefined) {
      check = async () => Boolean(await guest.executeJavaScript(`!!(${fn})`, false))
    } else {
      return fail('condition-required')
    }
    return (await waitFor(check, timeoutMs))
      ? { ok: true }
      : fail('timeout', `condition not met within ${timeoutMs}ms`)
  })

  method('mouse', async (guest, p) => {
    const button = (str(p.button) ?? 'left') as MouseButton
    if (!['left', 'right', 'middle'].includes(button)) return fail('bad-button', button)
    switch (p.action) {
      case 'move': {
        const x = num(p.x)
        const y = num(p.y)
        if (x === undefined || y === undefined) return fail('coordinates-required')
        mouseMove(guest, x, y)
        break
      }
      case 'down':
        mouseButton(guest, 'mouseDown', button, 1)
        break
      case 'up':
        mouseButton(guest, 'mouseUp', button, 1)
        break
      case 'wheel': {
        const pos = mousePositions.get(guest.id) ?? { x: 0, y: 0 }
        const at = zoomed(guest, pos.x, pos.y)
        guest.sendInputEvent({
          type: 'mouseWheel',
          x: at.x,
          y: at.y,
          deltaX: -(num(p.dx) ?? 0),
          deltaY: -(num(p.dy) ?? 0),
        })
        break
      }
      default:
        return fail('bad-sub', String(p.action))
    }
    await settle(guest)
    return { ok: true }
  })

  method('set', async (guest, p) => {
    switch (p.what) {
      case 'viewport': {
        const width = num(p.width)
        const height = num(p.height)
        if (!width || !height) return fail('size-required')
        await debuggerCommand(guest, 'Emulation.setDeviceMetricsOverride', {
          width: Math.round(width),
          height: Math.round(height),
          deviceScaleFactor: num(p.scale) ?? 0,
          mobile: false,
        })
        return { ok: true }
      }
      case 'media': {
        const features: { name: string; value: string }[] = []
        if (p.colorScheme === 'dark' || p.colorScheme === 'light') {
          features.push({ name: 'prefers-color-scheme', value: p.colorScheme })
        }
        features.push({
          name: 'prefers-reduced-motion',
          value: p.reducedMotion === true ? 'reduce' : '',
        })
        await debuggerCommand(guest, 'Emulation.setEmulatedMedia', { features })
        return { ok: true }
      }
      case 'offline':
        await debuggerCommand(guest, 'Network.emulateNetworkConditions', {
          offline: p.offline === true,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        })
        return { ok: true }
      case 'headers': {
        const headers = p.headers
        if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
          return fail('headers-required')
        }
        const clean: Record<string, string> = {}
        for (const [k, v] of Object.entries(headers)) clean[k] = String(v)
        await debuggerCommand(guest, 'Network.setExtraHTTPHeaders', { headers: clean })
        return { ok: true }
      }
      case 'geo': {
        const latitude = num(p.latitude)
        const longitude = num(p.longitude)
        if (latitude === undefined || longitude === undefined) return fail('coordinates-required')
        await debuggerCommand(guest, 'Emulation.setGeolocationOverride', {
          latitude,
          longitude,
          accuracy: 1,
        })
        return { ok: true }
      }
      default:
        return fail('unsupported', String(p.what))
    }
  })

  method('cookies', async (guest, p) => {
    switch (p.sub ?? 'get') {
      case 'get': {
        const url = str(p.url)
        return { ok: true, cookies: await listCookies(guest, url ? { url } : {}) }
      }
      case 'set': {
        const name = str(p.name)
        if (!name) return fail('name-required')
        const url = str(p.url) ?? guest.getURL()
        const domain = str(p.domain)
        const host = (() => {
          try {
            return new URL(url).hostname
          } catch {
            return ''
          }
        })()
        if (!domain && !host) return fail('url-required')
        const sameSite = str(p.sameSite)?.toLowerCase()
        await writeCookie(guest, {
          name,
          value: str(p.value) ?? '',
          domain: domain ?? host,
          path: str(p.path) ?? '/',
          hostOnly: domain === undefined,
          expires: num(p.expires) ?? null,
          httpOnly: p.httpOnly === true,
          secure: p.secure === true || url.startsWith('https:'),
          sameSite:
            sameSite === 'strict' || sameSite === 'lax'
              ? sameSite
              : sameSite === 'none'
                ? 'no_restriction'
                : 'unspecified',
        })
        return { ok: true }
      }
      case 'clear':
        return clearStorage(guest, 'cookies')
      default:
        return fail('bad-sub', String(p.sub))
    }
  })

  method('storage', async (guest, p) => {
    const area = p.area
    if (area !== 'local' && area !== 'session') return fail('bad-area', String(area))
    switch (p.sub ?? 'get') {
      case 'get': {
        const dump = await readWebStorage(guest)
        const values = area === 'local' ? dump.local : dump.session
        const key = str(p.key)
        if (key === undefined) return { ok: true, origin: dump.origin, values }
        return { ok: true, key, value: key in values ? values[key] : null }
      }
      case 'set': {
        const key = str(p.key)
        if (!key) return fail('key-required')
        return world(guest, `setStorage(${jsArgs(area as StorageArea, key, str(p.value) ?? '')})`)
      }
      case 'clear':
        return world(guest, `clearStorage(${jsArgs(area)})`)
      default:
        return fail('bad-sub', String(p.sub))
    }
  })

  method('network', async (guest, p) => {
    switch (p.sub) {
      case 'requests': {
        if (p.clear === true) {
          clearRequestLog(guest.id)
          return { ok: true }
        }
        const filter: NetworkFilter = {
          filter: str(p.filter),
          types: Array.isArray(p.types) ? p.types.map(String) : undefined,
          method: str(p.method),
          status: str(p.status),
        }
        return {
          ok: true,
          requests: filterRequests(requestsFor(guest.id), filter).map(summarizeRequest),
        }
      }
      case 'request': {
        const id = str(p.requestId)
        const found = requestsFor(guest.id).find((r) => r.requestId === id)
        return found ? { ok: true, request: found } : fail('not-found', id)
      }
      case 'route': {
        const pattern = str(p.url)
        if (!pattern) return fail('url-required')
        const routes = (guestRoutes.get(guest.id) ?? []).filter((r) => r.pattern !== pattern)
        routes.push({ pattern, abort: p.abort === true, body: str(p.body) })
        guestRoutes.set(guest.id, routes)
        await applyRoutes(guest)
        return { ok: true, routes: routes.map((r) => r.pattern) }
      }
      case 'unroute': {
        const pattern = str(p.url)
        const routes = pattern
          ? (guestRoutes.get(guest.id) ?? []).filter((r) => r.pattern !== pattern)
          : []
        guestRoutes.set(guest.id, routes)
        await applyRoutes(guest)
        return { ok: true, routes: routes.map((r) => r.pattern) }
      }
      default:
        return fail('bad-sub', String(p.sub))
    }
  })

  registerTargetableMethod('browse.tab', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const p = (params ?? {}) as Params
      const sub = p.sub ?? 'list'
      if (sub === 'new') return openTab(ctx, normalizeUrl(str(p.url) ?? 'about:blank'), false)
      if (sub === 'list') {
        const activeId = defaultBrowserPane(deps, ctx)
        const tabs = [...workspaceBrowsers(ctx.identity.workspaceId)].flatMap((id) => {
          const guest = liveGuest(deps.browserPanes.get(id))
          if (!guest) return []
          return [
            deps.isSharedPane(id) ? sharedTabEntry(id, activeId) : tabEntry(id, guest, activeId),
          ]
        })
        return { ok: true, tabs }
      }
      if (sub !== 'switch' && sub !== 'close') return fail('bad-sub', String(sub))
      const resolution = await resolveGuest(deps, ctx, str(p.target) ?? str(p.paneId))
      if (!resolution.ok) return resolution
      const identity = getByPaneId(resolution.rendererPaneId)
      if (!identity) return fail('no-browser-pane')
      const res = await deps.execCommand(
        commandTarget(identity),
        sub === 'switch' ? 'pane.focus' : 'pane.close',
        { paneId: identity.paneId },
      )
      if (!res.ok) return fail('command-failed', res.error.message)
      if (sub === 'switch') {
        if (identity.workspaceId === ctx.identity.workspaceId) {
          activeTabs.set(ctx.identity.paneId, identity.paneId)
        }
        return { ok: true, ...tabEntry(identity.paneId, resolution.guest, identity.paneId) }
      }
      if (activeTabs.get(ctx.identity.paneId) === identity.paneId) {
        activeTabs.delete(ctx.identity.paneId)
      }
      return { ok: true }
    },
  })

  method('frame', (guest, p) => {
    const target = str(p.target)
    const reset = !target || target === 'main' || target === 'top'
    return world(guest, `frame(${jsArgs(reset ? null : target)})`)
  })

  method('dialog', async (guest, p) => {
    const sub = p.sub
    if (sub === 'status') {
      const dialogs = await guest.executeJavaScript('window.__ostiaDialogs || []', true)
      return { ok: true, policy: dialogPolicies.get(guest.id)?.policy ?? null, dialogs }
    }
    if (sub !== 'accept' && sub !== 'dismiss') return fail('bad-sub', String(sub))
    const policy = {
      policy: sub as 'accept' | 'dismiss',
      text: sub === 'accept' ? (str(p.text) ?? null) : null,
    }
    dialogPolicies.set(guest.id, policy)
    if (!dialogInitAttached.has(guest.id)) {
      await addInitScript(guest, DIALOG_OVERRIDE_JS)
      dialogInitAttached.add(guest.id)
    }
    await guest.executeJavaScript(DIALOG_OVERRIDE_JS, true)
    await guest.executeJavaScript(`window.__ostiaDialogPolicy = ${JSON.stringify(policy)};`, true)
    return { ok: true }
  })

  const bufferMethod = (name: string, buffer: Map<number, ConsoleEntry[]>): void => {
    method(name, (guest, p) => {
      if (p.clear === true) {
        buffer.delete(guest.id)
        return { ok: true }
      }
      return { ok: true, entries: buffer.get(guest.id) ?? [] }
    })
  }
  bufferMethod('console', deps.consoleBuffers)
  bufferMethod('errors', deps.errorBuffers)

  method('highlight', (guest, p) =>
    world(guest, `highlight(${jsArgs(str(p.target), num(p.ms) ?? 1500)})`),
  )

  method('inspect', (guest) => {
    guest.openDevTools()
    return { ok: true }
  })

  method('state', async (guest, p) => {
    const requested = str(p.path)
    if (!requested) return fail('path-required')
    const path = safeOutPath(deps, requested)
    if (!path) return fail('path-denied', requested)
    if (p.sub === 'save') {
      const web: WebStorageDump = await readWebStorage(guest)
      const state: StateFile = {
        cookies: await listCookies(guest),
        localStorage: web.local,
        sessionStorage: web.session,
      }
      writeOut(path, JSON.stringify(state, null, 2))
      return { ok: true, path }
    }
    if (p.sub === 'load') {
      const state = JSON.parse(readFileSync(path, 'utf8')) as Partial<StateFile>
      for (const cookie of state.cookies ?? []) await writeCookie(guest, cookie)
      for (const [area, values] of [
        ['local', state.localStorage ?? {}],
        ['session', state.sessionStorage ?? {}],
      ] as const) {
        for (const [key, value] of Object.entries(values)) {
          await runInBrowseWorld(guest, `setStorage(${jsArgs(area, key, String(value))})`)
        }
      }
      return { ok: true, path }
    }
    return fail('bad-sub', String(p.sub))
  })

  method('pushstate', async (guest, p) => {
    const url = str(p.url)
    if (!url) return fail('url-required')
    const via = await guest.executeJavaScript(
      `(() => {
        const url = ${JSON.stringify(url)};
        const router = window.next && window.next.router;
        if (router && typeof router.push === 'function') { router.push(url); return 'next-router'; }
        history.pushState(history.state, '', url);
        window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
        return 'history';
      })()`,
      true,
    )
    return { ok: true, via, url: guest.getURL() }
  })

  method('addinitscript', (guest, p) => {
    const js = str(p.js)
    if (!js) return fail('js-required')
    return addInitScript(guest, js)
  })

  method('removeinitscript', async (guest, p) => {
    const identifier = str(p.identifier)
    if (!identifier) return fail('identifier-required')
    await debuggerCommand(guest, 'Page.removeScriptToEvaluateOnNewDocument', { identifier })
    return { ok: true }
  })

  method('addstyle', async (guest, p) => {
    const css = str(p.css)
    if (!css) return fail('css-required')
    return { ok: true, key: await guest.insertCSS(css) }
  })

  method('download', async (guest, p) => {
    const requested = str(p.path)
    const savePath = requested ? safeOutPath(deps, requested) : null
    if (requested && !savePath) return fail('path-denied', requested)
    const timeoutMs = clampTimeout(p.timeoutMs)
    return new Promise((resolve) => {
      let settled = false
      const onWillDownload = (_event: Electron.Event, item: Electron.DownloadItem): void => {
        if (settled) return
        if (savePath) {
          mkdirSync(dirname(savePath), { recursive: true })
          item.setSavePath(savePath)
        }
        item.once('done', (_doneEvent, state) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(
            state === 'completed'
              ? { ok: true, path: item.getSavePath(), filename: item.getFilename() }
              : fail('download-failed', state),
          )
        })
      }
      guest.session.once('will-download', onWillDownload)
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        guest.session.removeListener('will-download', onWillDownload)
        resolve(fail('timeout', `no download within ${timeoutMs}ms`))
      }, timeoutMs)
    })
  })

  method('history', (guest, p) => {
    if (p.sub !== 'clear') return fail('bad-sub', String(p.sub))
    guest.navigationHistory.clear()
    return { ok: true }
  })

  method('identify', (guest, _p, _ctx, rendererPaneId) => {
    const identity = getByPaneId(rendererPaneId)
    if (!identity) return fail('no-browser-pane')
    return {
      ok: true,
      tabId: identity.externalId,
      url: guest.getURL(),
      title: guest.getTitle(),
      workspaceId: identity.workspaceId,
      windowId: identity.windowId,
    }
  })

  method('zoom', (guest, p) => {
    const current = guest.getZoomLevel()
    const zoom =
      p.action === 'reset'
        ? 0
        : p.action === 'in'
          ? current + 0.5
          : p.action === 'out'
            ? current - 0.5
            : null
    if (zoom === null) return fail('bad-action', String(p.action))
    guest.setZoomLevel(zoom)
    return { ok: true, zoom }
  })

  method('focusMode', async (_guest, p, _ctx, rendererPaneId) => {
    const action = p.action
    if (action !== 'enter' && action !== 'exit' && action !== 'toggle') {
      return fail('bad-action', String(action))
    }
    const identity = getByPaneId(rendererPaneId)
    if (!identity) return fail('no-browser-pane')
    const zoom = action === 'enter' ? true : action === 'exit' ? false : undefined
    const res = await deps.execCommand(commandTarget(identity), 'pane.zoom', {
      paneId: identity.paneId,
      zoom,
    })
    return res.ok ? { ok: true } : fail('command-failed', res.error.message)
  })

  method('reactGrab', async (guest, p) => {
    if (p.action === 'get') {
      return {
        ok: true,
        entry: await guest.executeJavaScript('window.__ostiaReactGrab || null', true),
      }
    }
    if (p.action !== 'toggle') return fail('bad-action', String(p.action))
    const turningOn = !reactGrabOn.has(guest.id)
    await guest.executeJavaScript(turningOn ? REACT_GRAB_ON_JS : REACT_GRAB_OFF_JS, true)
    if (turningOn) reactGrabOn.add(guest.id)
    else reactGrabOn.delete(guest.id)
    return { ok: true, on: turningOn }
  })

  method('focusWebview', (guest) => {
    guest.focus()
    return { ok: true }
  })

  method('isWebviewFocused', (guest) => ({ ok: true, focused: guest.isFocused() }))
}

function withRef(ref: string, outcome: BrowseOutcome): BrowseOutcome<{ ref?: string }> {
  return outcome.ok ? { ok: true, ref } : outcome
}

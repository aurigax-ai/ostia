import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { webContents } from 'electron'
import type { CommandResult, CommandTarget } from '../shared/types'
import { type AuthedConn, connHasCap } from './controlAuth'
import { registerControlMethod } from './controlServer'
import { type PaneIdentity, getByPaneId, resolveExternal } from './idRegistry'
import { resolveSafe } from './pathGuard'
import { privateTmpDir } from './privateTmp'

type MethodCtx = { identity: PaneIdentity; authed: AuthedConn }

export interface BrowseDeps {
  browserPanes: Map<string, number>
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  screenshotRoots: string[]
  consoleBuffers: Map<number, ConsoleEntry[]>
  errorBuffers: Map<number, ConsoleEntry[]>
}

export interface ConsoleEntry {
  level: string
  text: string
  ts: number
}

export const MAX_CONSOLE_ENTRIES = 500

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

export function consoleLevelName(level: number): string {
  return (['verbose', 'info', 'warning', 'error'] as const)[level] ?? 'info'
}

export const PINE_ERROR_PREFIX = '[pine-error]'

export const PAGE_ERROR_CATCHER_JS = `(() => {
  if (window.__pineErrCatcher) return;
  window.__pineErrCatcher = true;
  window.onerror = function (message, source, lineno, colno, error) {
    console.error('${PINE_ERROR_PREFIX}', error && error.stack ? error.stack : message);
  };
  window.onunhandledrejection = function (event) {
    var reason = event && event.reason;
    console.error('${PINE_ERROR_PREFIX}', reason && reason.stack ? reason.stack : String(reason));
  };
})();`

const frameSelectors = new Map<number, string>()

export function clearGuestFrame(wcId: number): void {
  frameSelectors.delete(wcId)
}

const dialogPolicies = new Map<number, { policy: 'accept' | 'dismiss'; text: string | null }>()

const dialogInitAttached = new Set<number>()

export function clearGuestDialogPolicy(wcId: number): void {
  dialogPolicies.delete(wcId)
  dialogInitAttached.delete(wcId)
}

const reactGrabOn = new Set<number>()

export function clearGuestReactGrab(wcId: number): void {
  reactGrabOn.delete(wcId)
}

const MAX_DIALOG_ENTRIES = 200

const DIALOG_OVERRIDE_JS = `(() => {
  if (window.__pineDialogPatched) return;
  window.__pineDialogPatched = true;
  window.__pineDialogs = window.__pineDialogs || [];
  window.__pineDialogPolicy = window.__pineDialogPolicy || { policy: 'dismiss', text: null };
  function log(type, message) {
    window.__pineDialogs.push({ type: type, message: String(message), ts: Date.now() });
    if (window.__pineDialogs.length > ${MAX_DIALOG_ENTRIES}) {
      window.__pineDialogs.splice(0, window.__pineDialogs.length - ${MAX_DIALOG_ENTRIES});
    }
  }
  window.alert = function (message) {
    log('alert', message);
  };
  window.confirm = function (message) {
    log('confirm', message);
    return window.__pineDialogPolicy.policy === 'accept';
  };
  window.prompt = function (message) {
    log('prompt', message);
    return window.__pineDialogPolicy.policy === 'accept' ? (window.__pineDialogPolicy.text || '') : null;
  };
})();`

const REACT_GRAB_ON_JS = `(() => {
  if (window.__pineReactGrabOn) return true;
  window.__pineReactGrabOn = true;
  window.__pineReactGrab = window.__pineReactGrab || null;
  function findFiber(el) {
    for (const key in el) {
      if (key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0) {
        return el[key];
      }
    }
    return null;
  }
  window.__pineReactGrabHandler = function (e) {
    let el = e.target;
    let fiber = null;
    while (el && !fiber) {
      fiber = findFiber(el);
      if (!fiber) el = el.parentElement;
    }
    if (!fiber) {
      window.__pineReactGrab = { component: null, file: null, line: null };
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
    window.__pineReactGrab = {
      component: component,
      file: source ? source.fileName : null,
      line: source ? source.lineNumber : null,
    };
  };
  document.addEventListener('click', window.__pineReactGrabHandler, true);
  return true;
})();`

const REACT_GRAB_OFF_JS = `(() => {
  if (!window.__pineReactGrabOn) return true;
  window.__pineReactGrabOn = false;
  if (window.__pineReactGrabHandler) {
    document.removeEventListener('click', window.__pineReactGrabHandler, true);
  }
  return true;
})();`

type GuestResolution =
  | { ok: true; guest: Electron.WebContents; rendererPaneId: string }
  | { ok: false; error: 'no-browser-pane' }
  | { ok: false; error: 'browser-not-ready' }
  | { ok: false; error: 'needs-elevation' }

export function resolveGuest(
  deps: Pick<BrowseDeps, 'browserPanes'>,
  ctx: MethodCtx,
  paneId?: string,
): GuestResolution {
  if (paneId) {
    const identity = resolveExternal(paneId)
    if (!identity) return { ok: false, error: 'no-browser-pane' }
    const wcId = deps.browserPanes.get(identity.paneId)
    if (wcId === undefined) return { ok: false, error: 'browser-not-ready' }
    const crossBoundary =
      identity.sessionId !== ctx.identity.sessionId || identity.windowId !== ctx.identity.windowId
    if (crossBoundary && !connHasCap(ctx.authed, 'workspace-wide')) {
      return { ok: false, error: 'needs-elevation' }
    }
    const guest = webContents.fromId(wcId)
    if (!guest || guest.isDestroyed()) return { ok: false, error: 'browser-not-ready' }
    return { ok: true, guest, rendererPaneId: identity.paneId }
  }
  for (const [rendererPaneId, wcId] of deps.browserPanes) {
    if (getByPaneId(rendererPaneId)?.sessionId !== ctx.identity.sessionId) continue
    const guest = webContents.fromId(wcId)
    if (!guest || guest.isDestroyed()) continue
    return { ok: true, guest, rendererPaneId }
  }
  return { ok: false, error: 'no-browser-pane' }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const MAX_HTML_CHARS = 1_000_000

const screenshotCounters = new Map<string, number>()

function scratchScreenshotPath(rendererPaneId: string): string {
  const n = (screenshotCounters.get(rendererPaneId) ?? 0) + 1
  screenshotCounters.set(rendererPaneId, n)
  return join(privateTmpDir('pine-screens'), `${rendererPaneId}-${n}.png`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const KEY_ALIASES: Record<string, string> = {
  Enter: 'Return',
  Esc: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
  Space: 'Space',
}

function toElectronKeyCode(key: string): string {
  return KEY_ALIASES[key] ?? key
}

function isPrintableKey(key: string): boolean {
  return [...key].length === 1
}

function sendKeyDown(guest: Electron.WebContents, key: string): void {
  guest.sendInputEvent({ type: 'keyDown', keyCode: toElectronKeyCode(key) })
  if (isPrintableKey(key)) {
    guest.sendInputEvent({ type: 'char', keyCode: key })
  }
}

function sendKeyUp(guest: Electron.WebContents, key: string): void {
  guest.sendInputEvent({ type: 'keyUp', keyCode: toElectronKeyCode(key) })
}

const ENSURE_INJECTED = `
if (!window.__pine) {
  window.__pine = {
    refs: {},
    n: 0,
    // Current-frame pointer for \`browse.frame\` — null/unset means "top document". Set via a
    // direct \`window.__pine.frameSel = ...\` write (browse.frame's own injected JS), read fresh
    // by \`frameDoc()\` on every call rather than captured at prelude-definition time, since
    // \`window.__pine\` (and its methods) are only defined ONCE per page load (guarded by the
    // \`if (!window.__pine)\` above) — a plain data field is what lets a later \`browse.frame\`
    // call actually change resolveEl's behavior for calls after it.
    frameSel: null,
    frameDoc() {
      if (!this.frameSel) return document;
      try {
        const el = document.querySelector(this.frameSel);
        const doc = el && el.contentDocument;
        return doc || document;
      } catch (e) {
        return document;
      }
    },
    ref(el) {
      this.n += 1;
      const id = 'e' + this.n;
      this.refs[id] = el;
      return id;
    },
    resolveEl(sel) {
      if (typeof sel === 'string' && /^@?e\\d+$/.test(sel)) {
        return this.refs[sel.replace('@', '')] || null;
      }
      return sel ? this.frameDoc().querySelector(sel) : null;
    },
    roleOf(el) {
      const explicit = el.getAttribute && el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        return 'textbox';
      }
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'img') return 'img';
      if (tag === 'label') return 'label';
      return tag || 'node';
    },
    nameOf(el) {
      const aria = el.getAttribute && el.getAttribute('aria-label');
      if (aria && aria.trim()) return aria.trim();
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'img') return (el.getAttribute('alt') || '').trim();
      const text = (el.innerText || el.value || '').toString().trim();
      if (text) return text.slice(0, 80);
      const placeholder = el.getAttribute && el.getAttribute('placeholder');
      if (placeholder && placeholder.trim()) return placeholder.trim();
      const title = el.getAttribute && el.getAttribute('title');
      return (title || '').trim();
    },
  };
}
`

function withInjected(body: string): string {
  return `${ENSURE_INJECTED}\n(() => {\n${body}\n})()`
}

async function runSelectorJs(
  guest: Electron.WebContents,
  js: string,
): Promise<{ ok: true } | { ok: false; error: string; message?: string }> {
  try {
    const found = await guest.executeJavaScript(js, true)
    return found ? { ok: true } : { ok: false, error: 'not-found' }
  } catch (e) {
    return { ok: false, error: 'eval-failed', message: errMessage(e) }
  }
}

async function evalToResult(
  guest: Electron.WebContents,
  js: string,
): Promise<{ ok: true; result: string } | { ok: false; error: string; message?: string }> {
  try {
    const raw = await guest.executeJavaScript(js, true)
    let result: string
    try {
      result = JSON.stringify(raw) ?? String(raw)
    } catch {
      result = String(raw)
    }
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: 'eval-failed', message: errMessage(e) }
  }
}

function cookieUrl(cookie: Electron.Cookie): string {
  const domain = (cookie.domain ?? '').replace(/^\./, '')
  return `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path ?? '/'}`
}

interface BrowseStateFile {
  cookies: Electron.Cookie[]
  localStorage: Record<string, string>
  sessionStorage: Record<string, string>
}

function focusSelectorJs(selector: string): string {
  return withInjected(`
    const el = window.__pine.resolveEl(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    return true;
  `)
}

async function cdpAddInitScript(
  guest: Electron.WebContents,
  js: string,
): Promise<{ ok: true; identifier: string } | { ok: false; error: string; message?: string }> {
  try {
    if (!guest.debugger.isAttached()) {
      guest.debugger.attach('1.3')
    }
  } catch (e) {
    return { ok: false, error: 'debugger-attach-failed', message: errMessage(e) }
  }
  try {
    await guest.debugger.sendCommand('Page.enable')
    const result = (await guest.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: js,
    })) as { identifier: string }
    return { ok: true, identifier: result.identifier }
  } catch (e) {
    return { ok: false, error: 'debugger-command-failed', message: errMessage(e) }
  }
}

const MAX_SNAPSHOT_NODES = 2000
const DEFAULT_SNAPSHOT_MAX_DEPTH = 40
const MAX_SNAPSHOT_MAX_DEPTH = 200

export function registerBrowseMethods(deps: BrowseDeps): void {
  registerControlMethod('browse.open', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { url, paneId } = (params ?? {}) as { url: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (resolution.ok) {
        resolution.guest.loadURL(url).catch(() => {})
        return { ok: true, paneId: getByPaneId(resolution.rendererPaneId)?.externalId }
      }
      const target: CommandTarget = {
        windowId: ctx.identity.windowId,
        sessionId: ctx.identity.sessionId,
        paneId: ctx.identity.paneId,
      }
      const res = await deps.execCommand(target, 'browser.new', { url })
      if (!res.ok) {
        return { ok: false, error: 'browser-not-ready', message: res.error.message }
      }
      return { ok: true, created: true }
    },
  })

  registerControlMethod('browse.nav', {
    cap: 'browse',
    handler: (params, ctx) => {
      const { action, paneId } = (params ?? {}) as {
        action: 'back' | 'forward' | 'reload'
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      if (action === 'back') resolution.guest.goBack()
      else if (action === 'forward') resolution.guest.goForward()
      else resolution.guest.reload()
      return { ok: true }
    },
  })

  registerControlMethod('browse.read', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { selector, paneId } = (params ?? {}) as { selector?: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const selJs = JSON.stringify(selector ?? null)
      const js = withInjected(`
        const sel = ${selJs};
        if (sel) { const el = window.__pine.resolveEl(sel); return el ? el.innerText : ''; }
        return document.body ? document.body.innerText : '';
      `)
      try {
        const text = await resolution.guest.executeJavaScript(js, true)
        return { ok: true, text: typeof text === 'string' ? text : String(text ?? '') }
      } catch (e) {
        return { ok: false, error: 'eval-failed', message: errMessage(e) }
      }
    },
  })

  registerControlMethod('browse.click', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { selector, paneId } = (params ?? {}) as { selector: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const selJs = JSON.stringify(selector)
      const js = withInjected(`
        const el = window.__pine.resolveEl(${selJs});
        if (!el) return false;
        el.click();
        return true;
      `)
      try {
        const found = await resolution.guest.executeJavaScript(js, true)
        return found ? { ok: true } : { ok: false, error: 'not-found' }
      } catch (e) {
        return { ok: false, error: 'eval-failed', message: errMessage(e) }
      }
    },
  })

  registerControlMethod('browse.type', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { selector, text, paneId } = (params ?? {}) as {
        selector: string
        text: string
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const selJs = JSON.stringify(selector)
      const textJs = JSON.stringify(text)
      const js = withInjected(`
        const el = window.__pine.resolveEl(${selJs});
        if (!el) return false;
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${textJs}); else el.value = ${textJs};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      `)
      try {
        const found = await resolution.guest.executeJavaScript(js, true)
        return found ? { ok: true } : { ok: false, error: 'not-found' }
      } catch (e) {
        return { ok: false, error: 'eval-failed', message: errMessage(e) }
      }
    },
  })

  registerControlMethod('browse.dblclick', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { selector, paneId } = (params ?? {}) as { selector: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const js = withInjected(`
        const el = window.__pine.resolveEl(${JSON.stringify(selector)});
        if (!el) return false;
        el.click?.();
        el.click?.();
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return true;
      `)
      return runSelectorJs(resolution.guest, js)
    },
  })

  registerControlMethod('browse.hover', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { selector, paneId } = (params ?? {}) as { selector: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const js = withInjected(`
        const el = window.__pine.resolveEl(${JSON.stringify(selector)});
        if (!el) return false;
        const opts = { bubbles: true };
        el.dispatchEvent(new MouseEvent('mouseover', opts));
        el.dispatchEvent(new MouseEvent('mouseenter', opts));
        el.dispatchEvent(new MouseEvent('mousemove', opts));
        return true;
      `)
      return runSelectorJs(resolution.guest, js)
    },
  })

  registerControlMethod('browse.focus', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { selector, paneId } = (params ?? {}) as { selector: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      return runSelectorJs(resolution.guest, focusSelectorJs(selector))
    },
  })

  const registerCheckMethod = (name: string, checked: boolean): void => {
    registerControlMethod(name, {
      cap: 'browse',
      handler: async (params, ctx) => {
        const { selector, paneId } = (params ?? {}) as { selector: string; paneId?: string }
        const resolution = resolveGuest(deps, ctx, paneId)
        if (!resolution.ok) return resolution
        const js = withInjected(`
          const el = window.__pine.resolveEl(${JSON.stringify(selector)});
          if (!el) return false;
          el.checked = ${checked};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        `)
        return runSelectorJs(resolution.guest, js)
      },
    })
  }
  registerCheckMethod('browse.check', true)
  registerCheckMethod('browse.uncheck', false)

  registerControlMethod('browse.scrollIntoView', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { selector, paneId } = (params ?? {}) as { selector: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const js = withInjected(`
        const el = window.__pine.resolveEl(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        return true;
      `)
      return runSelectorJs(resolution.guest, js)
    },
  })

  registerControlMethod('browse.fill', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { selector, text, paneId } = (params ?? {}) as {
        selector: string
        text: string
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const js = withInjected(`
        const el = window.__pine.resolveEl(${JSON.stringify(selector)});
        if (!el) return false;
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      `)
      return runSelectorJs(resolution.guest, js)
    },
  })

  registerControlMethod('browse.select', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { selector, value, paneId } = (params ?? {}) as {
        selector: string
        value: string
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const valueJs = JSON.stringify(value)
      const js = withInjected(`
        const el = window.__pine.resolveEl(${JSON.stringify(selector)});
        if (!el) return false;
        el.value = ${valueJs};
        if (el.value !== ${valueJs}) {
          for (const opt of Array.from(el.options || [])) {
            if (opt.textContent.trim() === ${valueJs}) { el.value = opt.value; break; }
          }
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      `)
      return runSelectorJs(resolution.guest, js)
    },
  })

  registerControlMethod('browse.scroll', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { x, y, selector, paneId } = (params ?? {}) as {
        x?: number
        y?: number
        selector?: string
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const xJs = JSON.stringify(x ?? 0)
      const yJs = JSON.stringify(y ?? 0)
      const js = selector
        ? withInjected(`
            const el = window.__pine.resolveEl(${JSON.stringify(selector)});
            if (!el) return false;
            el.scrollBy(${xJs}, ${yJs});
            return true;
          `)
        : `(() => { window.scrollTo(${xJs}, ${yJs}); return true; })()`
      return runSelectorJs(resolution.guest, js)
    },
  })

  registerControlMethod('browse.press', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { key, selector, paneId } = (params ?? {}) as {
        key: string
        selector?: string
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      if (selector) {
        const focused = await runSelectorJs(resolution.guest, focusSelectorJs(selector))
        if (!focused.ok) return focused
      }
      sendKeyDown(resolution.guest, key)
      sendKeyUp(resolution.guest, key)
      return { ok: true }
    },
  })

  registerControlMethod('browse.keydown', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { key, selector, paneId } = (params ?? {}) as {
        key: string
        selector?: string
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      if (selector) {
        const focused = await runSelectorJs(resolution.guest, focusSelectorJs(selector))
        if (!focused.ok) return focused
      }
      sendKeyDown(resolution.guest, key)
      return { ok: true }
    },
  })

  registerControlMethod('browse.keyup', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { key, selector, paneId } = (params ?? {}) as {
        key: string
        selector?: string
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      if (selector) {
        const focused = await runSelectorJs(resolution.guest, focusSelectorJs(selector))
        if (!focused.ok) return focused
      }
      sendKeyUp(resolution.guest, key)
      return { ok: true }
    },
  })

  registerControlMethod('browse.eval', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { js, paneId } = (params ?? {}) as { js: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      return evalToResult(resolution.guest, js)
    },
  })

  registerControlMethod('browse.wait', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { selector, timeoutMs, paneId } = (params ?? {}) as {
        selector: string
        timeoutMs?: number
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const selJs = JSON.stringify(selector)
      const js = withInjected(`return !!window.__pine.resolveEl(${selJs});`)
      const deadline = Date.now() + Math.min(timeoutMs ?? 10_000, 30_000)
      for (;;) {
        try {
          if (await resolution.guest.executeJavaScript(js, true)) return { found: true }
        } catch {}
        if (Date.now() >= deadline) return { found: false, timedOut: true }
        await sleep(200)
      }
    },
  })

  registerControlMethod('browse.screenshot', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { path, paneId } = (params ?? {}) as { path?: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      let outPath: string
      if (path) {
        const safe = resolveSafe(path, deps.screenshotRoots)
        if (safe === null) return { ok: false, error: 'path-denied' }
        outPath = safe
      } else {
        outPath = scratchScreenshotPath(resolution.rendererPaneId)
      }
      try {
        const image = await resolution.guest.capturePage()
        mkdirSync(dirname(outPath), { recursive: true })
        writeFileSync(outPath, image.toPNG())
        return { ok: true, path: outPath }
      } catch (e) {
        return { ok: false, error: 'screenshot-failed', message: errMessage(e) }
      }
    },
  })

  registerControlMethod('browse.content', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { paneId } = (params ?? {}) as { paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      try {
        const html = await resolution.guest.executeJavaScript(
          `document.documentElement ? document.documentElement.outerHTML : ''`,
          true,
        )
        const text = typeof html === 'string' ? html : String(html ?? '')
        const truncated = text.length > MAX_HTML_CHARS
        return { ok: true, html: truncated ? text.slice(0, MAX_HTML_CHARS) : text, truncated }
      } catch (e) {
        return { ok: false, error: 'eval-failed', message: errMessage(e) }
      }
    },
  })

  registerControlMethod('browse.snapshot', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { selector, interactive, maxDepth, paneId } = (params ?? {}) as {
        selector?: string
        interactive?: boolean
        maxDepth?: number
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const selJs = JSON.stringify(selector ?? null)
      const interactiveJs = JSON.stringify(!!interactive)
      const clampedMaxDepth = Math.min(
        Math.max(maxDepth ?? DEFAULT_SNAPSHOT_MAX_DEPTH, 1),
        MAX_SNAPSHOT_MAX_DEPTH,
      )
      const maxDepthJs = JSON.stringify(clampedMaxDepth)
      const maxNodesJs = JSON.stringify(MAX_SNAPSHOT_NODES)
      const body = `
        const root = ${selJs} ? window.__pine.resolveEl(${selJs}) : document.body;
        if (!root) return { found: false };
        const maxNodes = ${maxNodesJs};
        const maxDepth = ${maxDepthJs};
        const interactiveOnly = ${interactiveJs};
        const lines = [];
        const refs = {};
        let count = 0;
        function isVisible(el) {
          return el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0) || el === document.body;
        }
        function hasOwnText(el) {
          for (const node of el.childNodes) {
            if (node.nodeType === 3 && node.textContent && node.textContent.trim()) return true;
          }
          return false;
        }
        function isActionable(el, role) {
          const tag = el.tagName.toLowerCase();
          if (tag === 'a' || tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea') return true;
          const actionableRoles = ['button','link','checkbox','radio','tab','menuitem','switch','textbox','combobox','slider','option'];
          if (actionableRoles.includes(role)) return true;
          if (el.hasAttribute('onclick')) return true;
          if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') return true;
          if (el.isContentEditable) return true;
          return false;
        }
        function walk(node, rawDepth, indent) {
          if (count >= maxNodes || rawDepth > maxDepth || node.nodeType !== 1) return;
          const role = window.__pine.roleOf(node);
          const tag = node.tagName.toLowerCase();
          const heading = /^h[1-6]$/.test(tag);
          const actionable = isActionable(node, role);
          const relevant =
            (interactiveOnly ? actionable : (actionable || heading || node.hasAttribute('role') || hasOwnText(node))) &&
            isVisible(node);
          let nextIndent = indent;
          if (relevant) {
            const ref = window.__pine.ref(node);
            const name = window.__pine.nameOf(node);
            let line = '  '.repeat(indent) + '[' + ref + '] ' + role + ' "' + name + '"';
            if (role === 'link') {
              const href = node.getAttribute('href');
              if (href) line += ' → ' + href;
            }
            lines.push(line);
            refs[ref] = { tag, role, name };
            count++;
            nextIndent = indent + 1;
          }
          const children = node.children ? Array.from(node.children) : [];
          for (const child of children) {
            if (count >= maxNodes) break;
            walk(child, rawDepth + 1, nextIndent);
          }
        }
        walk(root, 0, 0);
        return { found: true, snapshot: lines.join('\\n'), refs };
      `
      const js = withInjected(body)
      try {
        const result = (await resolution.guest.executeJavaScript(js, true)) as
          | {
              found: true
              snapshot: string
              refs: Record<string, { tag: string; role: string; name: string }>
            }
          | { found: false }
        if (!result?.found) return { ok: false, error: 'not-found' }
        return {
          ok: true,
          snapshot: `${result.snapshot}\n\n[refs invalidate on navigation]`,
          refs: result.refs,
        }
      } catch (e) {
        return { ok: false, error: 'eval-failed', message: errMessage(e) }
      }
    },
  })

  const GET_SUBS_NEEDING_SELECTOR = new Set([
    'text',
    'html',
    'value',
    'attr',
    'count',
    'box',
    'styles',
  ])

  registerControlMethod('browse.get', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { sub, selector, attr, property, paneId } = (params ?? {}) as {
        sub: string
        selector?: string
        attr?: string
        property?: string
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      if (GET_SUBS_NEEDING_SELECTOR.has(sub) && !selector) {
        return { ok: false, error: 'selector-required' }
      }
      if (sub === 'attr' && !attr) return { ok: false, error: 'attr-required' }
      const selJs = JSON.stringify(selector ?? null)
      const attrJs = JSON.stringify(attr ?? '')
      const propertyJs = JSON.stringify(property ?? null)
      let body: string
      switch (sub) {
        case 'url':
          body = 'return { found: true, value: location.href };'
          break
        case 'title':
          body = 'return { found: true, value: document.title };'
          break
        case 'text':
          body = `
            const el = window.__pine.resolveEl(${selJs});
            return el ? { found: true, value: el.innerText } : { found: false };
          `
          break
        case 'html':
          body = `
            const el = window.__pine.resolveEl(${selJs});
            return el ? { found: true, value: el.outerHTML } : { found: false };
          `
          break
        case 'value':
          body = `
            const el = window.__pine.resolveEl(${selJs});
            return el ? { found: true, value: el.value } : { found: false };
          `
          break
        case 'attr':
          body = `
            const el = window.__pine.resolveEl(${selJs});
            return el ? { found: true, value: el.getAttribute(${attrJs}) } : { found: false };
          `
          break
        case 'count':
          body = `return { found: true, value: document.querySelectorAll(${selJs}).length };`
          break
        case 'box':
          body = `
            const el = window.__pine.resolveEl(${selJs});
            if (!el) return { found: false };
            const r = el.getBoundingClientRect();
            return { found: true, value: { x: r.x, y: r.y, w: r.width, h: r.height } };
          `
          break
        case 'styles':
          body = `
            const el = window.__pine.resolveEl(${selJs});
            if (!el) return { found: false };
            const cs = getComputedStyle(el);
            const prop = ${propertyJs};
            if (prop) return { found: true, value: cs.getPropertyValue(prop) };
            const dict = {};
            for (const p of ['display','position','color','backgroundColor','fontSize','width','height']) {
              dict[p] = cs.getPropertyValue(p);
            }
            return { found: true, value: dict };
          `
          break
        default:
          return { ok: false, error: 'bad-sub' }
      }
      const js = withInjected(body)
      try {
        const result = (await resolution.guest.executeJavaScript(js, true)) as
          | { found: true; value: unknown }
          | { found: false }
        if (!result?.found) return { ok: false, error: 'not-found' }
        return { ok: true, value: result.value }
      } catch (e) {
        return { ok: false, error: 'eval-failed', message: errMessage(e) }
      }
    },
  })

  registerControlMethod('browse.is', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { sub, selector, paneId } = (params ?? {}) as {
        sub: string
        selector: string
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      if (!selector) return { ok: false, error: 'selector-required' }
      const selJs = JSON.stringify(selector)
      let body: string
      switch (sub) {
        case 'visible':
          body = `
            const el = window.__pine.resolveEl(${selJs});
            if (!el) return { found: false };
            const visible = el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
            return { found: true, value: visible };
          `
          break
        case 'enabled':
          body = `
            const el = window.__pine.resolveEl(${selJs});
            if (!el) return { found: false };
            return { found: true, value: !el.disabled };
          `
          break
        case 'checked':
          body = `
            const el = window.__pine.resolveEl(${selJs});
            if (!el) return { found: false };
            return { found: true, value: !!el.checked };
          `
          break
        default:
          return { ok: false, error: 'bad-sub' }
      }
      const js = withInjected(body)
      try {
        const result = (await resolution.guest.executeJavaScript(js, true)) as
          | { found: true; value: boolean }
          | { found: false }
        if (!result?.found) return { ok: false, error: 'not-found' }
        return { ok: true, value: result.value }
      } catch (e) {
        return { ok: false, error: 'eval-failed', message: errMessage(e) }
      }
    },
  })

  const VALID_FIND_BY = new Set([
    'role',
    'text',
    'label',
    'placeholder',
    'alt',
    'title',
    'testid',
    'first',
    'last',
    'nth',
  ])

  registerControlMethod('browse.find', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { by, query, exact, index, selector, paneId } = (params ?? {}) as {
        by: string
        query: string
        exact?: boolean
        index?: number
        selector?: string
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      if (!VALID_FIND_BY.has(by)) return { ok: false, error: 'bad-by' }
      if ((by === 'first' || by === 'last' || by === 'nth') && !selector) {
        return { ok: false, error: 'selector-required' }
      }
      const byJs = JSON.stringify(by)
      const queryJs = JSON.stringify(query ?? '')
      const exactJs = JSON.stringify(!!exact)
      const indexJs = JSON.stringify(index ?? 0)
      const selJs = JSON.stringify(selector ?? null)
      const body = `
        function matchStr(value, q, ex) {
          if (value == null) return false;
          return ex ? value === q : value.includes(q);
        }
        const scopeSel = ${selJs};
        const root = scopeSel ? (window.__pine.resolveEl(scopeSel) || document) : document;
        const by = ${byJs};
        const query = ${queryJs};
        const exact = ${exactJs};
        let match = null;
        if (by === 'testid') {
          const candidates = Array.from(root.querySelectorAll('[data-testid]'));
          match = candidates.find((el) => matchStr(el.getAttribute('data-testid'), query, exact)) || null;
        } else if (by === 'placeholder') {
          const candidates = Array.from(root.querySelectorAll('[placeholder]'));
          match = candidates.find((el) => matchStr(el.getAttribute('placeholder'), query, exact)) || null;
        } else if (by === 'alt') {
          const candidates = Array.from(root.querySelectorAll('[alt]'));
          match = candidates.find((el) => matchStr(el.getAttribute('alt'), query, exact)) || null;
        } else if (by === 'title') {
          const candidates = Array.from(root.querySelectorAll('[title]'));
          match = candidates.find((el) => matchStr(el.getAttribute('title'), query, exact)) || null;
        } else if (by === 'label') {
          const labels = Array.from(root.querySelectorAll('label[for]'));
          const byFor = labels.find((l) => matchStr((l.innerText || '').trim(), query, exact));
          if (byFor) match = document.getElementById(byFor.getAttribute('for'));
          if (!match) {
            const ariaCandidates = Array.from(root.querySelectorAll('[aria-label]'));
            match = ariaCandidates.find((el) => matchStr(el.getAttribute('aria-label'), query, exact)) || null;
          }
        } else if (by === 'role') {
          const candidates = Array.from(root.querySelectorAll('*'));
          match = candidates.find((el) => matchStr(window.__pine.roleOf(el), query, exact)) || null;
        } else if (by === 'text') {
          const candidates = Array.from(root.querySelectorAll('*')).filter((el) =>
            matchStr((el.innerText || el.textContent || '').trim(), query, exact),
          );
          candidates.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
          match = candidates[0] || null;
        } else if (by === 'first' || by === 'last' || by === 'nth') {
          const list = Array.from(document.querySelectorAll(scopeSel));
          if (by === 'first') match = list[0] || null;
          else if (by === 'last') match = list[list.length - 1] || null;
          else match = list[${indexJs}] || null;
        }
        if (!match) return { found: false };
        return { found: true, ref: window.__pine.ref(match) };
      `
      const js = withInjected(body)
      try {
        const result = (await resolution.guest.executeJavaScript(js, true)) as
          | { found: true; ref: string }
          | { found: false }
        if (!result?.found) return { ok: false, error: 'not-found' }
        return { ok: true, element_ref: `@${result.ref}` }
      } catch (e) {
        return { ok: false, error: 'eval-failed', message: errMessage(e) }
      }
    },
  })

  registerControlMethod('browse.highlight', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { selector, ms, paneId } = (params ?? {}) as {
        selector: string
        ms?: number
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      if (!selector) return { ok: false, error: 'selector-required' }
      const selJs = JSON.stringify(selector)
      const msJs = JSON.stringify(ms ?? 1500)
      const js = withInjected(`
        const el = window.__pine.resolveEl(${selJs});
        if (!el) return false;
        const prevOutline = el.style.outline;
        const prevShadow = el.style.boxShadow;
        const prevZ = el.style.zIndex;
        el.style.outline = '2px solid #ff3366';
        el.style.boxShadow = '0 0 0 4px rgba(255, 51, 102, 0.35)';
        el.style.zIndex = '2147483647';
        setTimeout(() => {
          el.style.outline = prevOutline;
          el.style.boxShadow = prevShadow;
          el.style.zIndex = prevZ;
        }, ${msJs});
        return true;
      `)
      return runSelectorJs(resolution.guest, js)
    },
  })

  registerControlMethod('browse.url', {
    cap: 'browse',
    handler: (params, ctx) => {
      const { paneId } = (params ?? {}) as { paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      return { ok: true, url: resolution.guest.getURL() }
    },
  })

  registerControlMethod('browse.zoom', {
    cap: 'browse',
    handler: (params, ctx) => {
      const { action, paneId } = (params ?? {}) as {
        action: 'in' | 'out' | 'reset'
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const { guest } = resolution
      let zoom: number
      if (action === 'reset') zoom = 0
      else if (action === 'in') zoom = guest.getZoomLevel() + 0.5
      else if (action === 'out') zoom = guest.getZoomLevel() - 0.5
      else return { ok: false, error: 'bad-action' }
      guest.setZoomLevel(zoom)
      return { ok: true, zoom }
    },
  })

  registerControlMethod('browse.devtools', {
    cap: 'browse',
    handler: (params, ctx) => {
      const { action, paneId } = (params ?? {}) as {
        action?: 'toggle' | 'open' | 'close' | 'console'
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const { guest } = resolution
      switch (action ?? 'toggle') {
        case 'open':
        case 'console':
          guest.openDevTools()
          break
        case 'close':
          guest.closeDevTools()
          break
        case 'toggle':
          if (guest.isDevToolsOpened()) guest.closeDevTools()
          else guest.openDevTools()
          break
        default:
          return { ok: false, error: 'bad-action' }
      }
      const note =
        action === 'console'
          ? "Electron can't target the Console panel specifically — opened DevTools"
          : undefined
      return { ok: true, open: guest.isDevToolsOpened(), note }
    },
  })

  registerControlMethod('browse.focusWebview', {
    cap: 'browse',
    handler: (params, ctx) => {
      const { paneId } = (params ?? {}) as { paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      resolution.guest.focus()
      return { ok: true }
    },
  })

  registerControlMethod('browse.isWebviewFocused', {
    cap: 'browse',
    handler: (params, ctx) => {
      const { paneId } = (params ?? {}) as { paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      return { ok: true, focused: resolution.guest.isFocused() }
    },
  })

  registerControlMethod('browse.identify', {
    cap: 'browse',
    handler: (params, ctx) => {
      const { paneId } = (params ?? {}) as { paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const identity = getByPaneId(resolution.rendererPaneId)
      if (!identity) return { ok: false, error: 'no-browser-pane' }
      return {
        ok: true,
        paneId: identity.externalId,
        url: resolution.guest.getURL(),
        title: resolution.guest.getTitle(),
        sessionId: identity.sessionId,
        windowId: identity.windowId,
      }
    },
  })

  registerControlMethod('browse.cookies', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { sub, name, value, url, domain, paneId } = (params ?? {}) as {
        sub: 'get' | 'set' | 'clear'
        name?: string
        value?: string
        url?: string
        domain?: string
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const { guest } = resolution
      try {
        if (sub === 'get') {
          const cookies = await guest.session.cookies.get({ url, name, domain })
          return { ok: true, cookies }
        }
        if (sub === 'set') {
          if (!name) return { ok: false, error: 'name-required' }
          await guest.session.cookies.set({ url: url || guest.getURL(), name, value, domain })
          return { ok: true }
        }
        if (sub === 'clear') {
          if (!name && !url && !domain) {
            await guest.session.clearStorageData({ storages: ['cookies'] })
            return { ok: true }
          }
          const matches = await guest.session.cookies.get({ url, name, domain })
          for (const cookie of matches) {
            await guest.session.cookies.remove(url || cookieUrl(cookie), cookie.name)
          }
          return { ok: true }
        }
        return { ok: false, error: 'bad-sub' }
      } catch (e) {
        return { ok: false, error: 'cookie-op-failed', message: errMessage(e) }
      }
    },
  })

  registerControlMethod('browse.storage', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { area, sub, key, value, paneId } = (params ?? {}) as {
        area: 'local' | 'session'
        sub: 'get' | 'set' | 'clear'
        key?: string
        value?: string
        paneId?: string
      }
      if (area !== 'local' && area !== 'session') return { ok: false, error: 'bad-area' }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const storageExpr = area === 'local' ? 'localStorage' : 'sessionStorage'
      const keyJs = JSON.stringify(key ?? null)
      let js: string
      switch (sub) {
        case 'get':
          js = `(() => {
            const key = ${keyJs};
            if (key === null) {
              const out = {};
              for (let i = 0; i < ${storageExpr}.length; i++) {
                const k = ${storageExpr}.key(i);
                out[k] = ${storageExpr}.getItem(k);
              }
              return out;
            }
            return ${storageExpr}.getItem(key);
          })()`
          break
        case 'set':
          if (!key) return { ok: false, error: 'key-required' }
          js = `(() => { ${storageExpr}.setItem(${keyJs}, ${JSON.stringify(value ?? '')}); return true; })()`
          break
        case 'clear':
          js = `(() => { ${storageExpr}.clear(); return true; })()`
          break
        default:
          return { ok: false, error: 'bad-sub' }
      }
      try {
        const result = await resolution.guest.executeJavaScript(js, true)
        return sub === 'get' ? { ok: true, value: result } : { ok: true }
      } catch (e) {
        return { ok: false, error: 'eval-failed', message: errMessage(e) }
      }
    },
  })

  registerControlMethod('browse.state', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { sub, path, paneId } = (params ?? {}) as {
        sub: 'save' | 'load'
        path: string
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      if (!path) return { ok: false, error: 'path-required' }
      const safePath = resolveSafe(path, deps.screenshotRoots)
      if (safePath === null) return { ok: false, error: 'path-denied' }
      const { guest } = resolution
      if (sub === 'save') {
        try {
          const cookies = await guest.session.cookies.get({})
          const storageJs = `(() => {
            const dump = (storage) => {
              const out = {};
              for (let i = 0; i < storage.length; i++) {
                const k = storage.key(i);
                out[k] = storage.getItem(k);
              }
              return out;
            };
            return { localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) };
          })()`
          const storage = (await guest.executeJavaScript(storageJs, true)) as {
            localStorage: Record<string, string>
            sessionStorage: Record<string, string>
          }
          const state: BrowseStateFile = {
            cookies,
            localStorage: storage.localStorage,
            sessionStorage: storage.sessionStorage,
          }
          mkdirSync(dirname(safePath), { recursive: true })
          writeFileSync(safePath, JSON.stringify(state, null, 2))
          return { ok: true, path: safePath }
        } catch (e) {
          return { ok: false, error: 'state-save-failed', message: errMessage(e) }
        }
      }
      if (sub === 'load') {
        try {
          const raw = readFileSync(safePath, 'utf8')
          const state = JSON.parse(raw) as Partial<BrowseStateFile>
          for (const cookie of state.cookies ?? []) {
            await guest.session.cookies.set({
              url: cookieUrl(cookie),
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path,
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
              expirationDate: cookie.expirationDate,
              sameSite: cookie.sameSite,
            })
          }
          const restoreJs = `(() => {
            const local = ${JSON.stringify(state.localStorage ?? {})};
            const session = ${JSON.stringify(state.sessionStorage ?? {})};
            Object.keys(local).forEach((k) => localStorage.setItem(k, local[k]));
            Object.keys(session).forEach((k) => sessionStorage.setItem(k, session[k]));
            return true;
          })()`
          await guest.executeJavaScript(restoreJs, true)
          return { ok: true, path: safePath }
        } catch (e) {
          return { ok: false, error: 'state-load-failed', message: errMessage(e) }
        }
      }
      return { ok: false, error: 'bad-sub' }
    },
  })

  registerControlMethod('browse.history', {
    cap: 'browse',
    handler: (params, ctx) => {
      const { sub, paneId } = (params ?? {}) as { sub: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      if (sub !== 'clear') return { ok: false, error: 'bad-sub' }
      const { guest } = resolution
      if (typeof guest.navigationHistory?.clear === 'function') {
        guest.navigationHistory.clear()
      } else {
        guest.clearHistory()
      }
      return { ok: true }
    },
  })

  registerControlMethod('browse.addscript', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { js, paneId } = (params ?? {}) as { js: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      return evalToResult(resolution.guest, js)
    },
  })

  registerControlMethod('browse.addstyle', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { css, paneId } = (params ?? {}) as { css: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      try {
        const key = await resolution.guest.insertCSS(css)
        return { ok: true, key }
      } catch (e) {
        return { ok: false, error: 'insert-css-failed', message: errMessage(e) }
      }
    },
  })

  registerControlMethod('browse.addinitscript', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { js, paneId } = (params ?? {}) as { js: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      return cdpAddInitScript(resolution.guest, js)
    },
  })

  const registerBufferMethod = (
    name: string,
    pickBuffer: (d: BrowseDeps) => Map<number, ConsoleEntry[]>,
  ): void => {
    registerControlMethod(name, {
      cap: 'browse',
      handler: (params, ctx) => {
        const { sub, paneId } = (params ?? {}) as { sub?: string; paneId?: string }
        const resolution = resolveGuest(deps, ctx, paneId)
        if (!resolution.ok) return resolution
        const resolvedSub = sub ?? 'list'
        if (resolvedSub !== 'list' && resolvedSub !== 'clear') {
          return { ok: false, error: 'bad-sub' }
        }
        const buffer = pickBuffer(deps)
        const wcId = resolution.guest.id
        if (resolvedSub === 'clear') {
          buffer.delete(wcId)
          return { ok: true }
        }
        return { ok: true, entries: buffer.get(wcId) ?? [] }
      },
    })
  }
  registerBufferMethod('browse.console', (d) => d.consoleBuffers)
  registerBufferMethod('browse.errors', (d) => d.errorBuffers)

  registerControlMethod('browse.frame', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { selector, paneId } = (params ?? {}) as { selector?: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const { guest } = resolution
      const isReset = !selector || selector === 'main' || selector === 'top'
      const selJs = JSON.stringify(isReset ? null : selector)
      const js = withInjected(`
        const sel = ${selJs};
        if (!sel) { window.__pine.frameSel = null; return { ok: true }; }
        let el;
        try {
          el = document.querySelector(sel);
        } catch (e) {
          return { ok: false, error: 'not-found' };
        }
        if (!el) return { ok: false, error: 'not-found' };
        let doc;
        try {
          doc = el.contentDocument;
        } catch (e) {
          return { ok: false, error: 'cross-origin-frame' };
        }
        if (!doc) return { ok: false, error: 'cross-origin-frame' };
        window.__pine.frameSel = sel;
        return { ok: true };
      `)
      try {
        const result = (await guest.executeJavaScript(js, true)) as
          | { ok: true }
          | { ok: false; error: string }
        if (result.ok) {
          if (isReset) clearGuestFrame(guest.id)
          else frameSelectors.set(guest.id, selector as string)
        }
        return result
      } catch (e) {
        return { ok: false, error: 'eval-failed', message: errMessage(e) }
      }
    },
  })

  const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000
  const MAX_DOWNLOAD_TIMEOUT_MS = 300_000

  registerControlMethod('browse.download', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { sub, path, timeoutMs, paneId } = (params ?? {}) as {
        sub?: string
        path?: string
        timeoutMs?: number
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      if (sub !== 'wait') return { ok: false, error: 'bad-sub' }
      let safePath: string | null = null
      if (path) {
        safePath = resolveSafe(path, deps.screenshotRoots)
        if (safePath === null) return { ok: false, error: 'path-denied' }
      }
      const { guest } = resolution
      const deadline = Math.min(timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS, MAX_DOWNLOAD_TIMEOUT_MS)
      return new Promise((resolve) => {
        let settled = false
        const onWillDownload = (_event: Electron.Event, item: Electron.DownloadItem): void => {
          if (settled) return
          if (safePath) {
            try {
              mkdirSync(dirname(safePath), { recursive: true })
            } catch {}
            item.setSavePath(safePath)
          }
          item.once('done', (_doneEvent, state) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({ path: item.getSavePath(), filename: item.getFilename(), state })
          })
        }
        guest.session.once('will-download', onWillDownload)
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          guest.session.removeListener('will-download', onWillDownload)
          resolve({ timedOut: true })
        }, deadline)
      })
    },
  })

  registerControlMethod('browse.navigate', {
    cap: 'browse',
    handler: (params, ctx) => {
      const { url, paneId } = (params ?? {}) as { url: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      resolution.guest.loadURL(url).catch(() => {})
      return { ok: true, paneId: getByPaneId(resolution.rendererPaneId)?.externalId }
    },
  })

  registerControlMethod('browse.openSplit', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { url } = (params ?? {}) as { url?: string; paneId?: string }
      const target: CommandTarget = {
        windowId: ctx.identity.windowId,
        sessionId: ctx.identity.sessionId,
        paneId: ctx.identity.paneId,
      }
      const res = await deps.execCommand(target, 'browser.new', { url })
      if (!res.ok) {
        return { ok: false, error: 'browser-not-ready', message: res.error.message }
      }
      return { ok: true, created: true }
    },
  })

  registerControlMethod('browse.tab', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { sub, url, target } = (params ?? {}) as {
        sub: 'new' | 'list' | 'switch' | 'close'
        url?: string
        target?: string
      }
      if (sub === 'new') {
        const cmdTarget: CommandTarget = {
          windowId: ctx.identity.windowId,
          sessionId: ctx.identity.sessionId,
          paneId: ctx.identity.paneId,
        }
        const res = await deps.execCommand(cmdTarget, 'browser.new', { url })
        if (!res.ok) return { ok: false, error: 'browser-not-ready', message: res.error.message }
        return { ok: true, created: true }
      }
      if (sub === 'list') {
        const tabs: { paneId: string; url: string; title: string }[] = []
        for (const [rendererPaneId, wcId] of deps.browserPanes) {
          const identity = getByPaneId(rendererPaneId)
          if (!identity || identity.sessionId !== ctx.identity.sessionId) continue
          const guest = webContents.fromId(wcId)
          if (!guest || guest.isDestroyed()) continue
          tabs.push({ paneId: identity.externalId, url: guest.getURL(), title: guest.getTitle() })
        }
        return { ok: true, tabs }
      }
      if (sub === 'switch' || sub === 'close') {
        if (!target) return { ok: false, error: 'target-required' }
        const resolution = resolveGuest(deps, ctx, target)
        if (!resolution.ok) return resolution
        const identity = getByPaneId(resolution.rendererPaneId)
        if (!identity) return { ok: false, error: 'no-browser-pane' }
        const cmdTarget: CommandTarget = {
          windowId: identity.windowId,
          sessionId: identity.sessionId,
          paneId: identity.paneId,
        }
        const res = await deps.execCommand(
          cmdTarget,
          sub === 'switch' ? 'pane.focus' : 'pane.close',
          { paneId: identity.paneId },
        )
        if (!res.ok) return { ok: false, error: 'command-failed', message: res.error.message }
        return { ok: true }
      }
      return { ok: false, error: 'bad-sub' }
    },
  })

  registerControlMethod('browse.dialog', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { sub, text, paneId } = (params ?? {}) as {
        sub: 'accept' | 'dismiss' | 'list'
        text?: string
        paneId?: string
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const { guest } = resolution
      if (sub === 'list') {
        try {
          const dialogs = await guest.executeJavaScript('window.__pineDialogs || []', true)
          return { ok: true, dialogs }
        } catch (e) {
          return { ok: false, error: 'eval-failed', message: errMessage(e) }
        }
      }
      if (sub !== 'accept' && sub !== 'dismiss') return { ok: false, error: 'bad-sub' }
      const policy = { policy: sub, text: sub === 'accept' ? (text ?? null) : null }
      dialogPolicies.set(guest.id, policy)
      if (!dialogInitAttached.has(guest.id)) {
        const cdpResult = await cdpAddInitScript(guest, DIALOG_OVERRIDE_JS)
        if (!cdpResult.ok) return cdpResult
        dialogInitAttached.add(guest.id)
      }
      try {
        await guest.executeJavaScript(DIALOG_OVERRIDE_JS, true)
        await guest.executeJavaScript(
          `window.__pineDialogPolicy = ${JSON.stringify(policy)};`,
          true,
        )
        return { ok: true }
      } catch (e) {
        return { ok: false, error: 'eval-failed', message: errMessage(e) }
      }
    },
  })

  registerControlMethod('browse.focusMode', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { action, paneId } = (params ?? {}) as {
        action: 'enter' | 'exit' | 'toggle'
        paneId?: string
      }
      if (action !== 'enter' && action !== 'exit' && action !== 'toggle') {
        return { ok: false, error: 'bad-action' }
      }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const identity = getByPaneId(resolution.rendererPaneId)
      if (!identity) return { ok: false, error: 'no-browser-pane' }
      const cmdTarget: CommandTarget = {
        windowId: identity.windowId,
        sessionId: identity.sessionId,
        paneId: identity.paneId,
      }
      const zoom = action === 'enter' ? true : action === 'exit' ? false : undefined
      const res = await deps.execCommand(cmdTarget, 'pane.zoom', { paneId: identity.paneId, zoom })
      if (!res.ok) return { ok: false, error: 'command-failed', message: res.error.message }
      return { ok: true }
    },
  })

  registerControlMethod('browse.reactGrab', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { action, paneId } = (params ?? {}) as { action: 'toggle' | 'get'; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const { guest } = resolution
      if (action === 'get') {
        try {
          const entry = await guest.executeJavaScript('window.__pineReactGrab || null', true)
          return { ok: true, entry }
        } catch (e) {
          return { ok: false, error: 'eval-failed', message: errMessage(e) }
        }
      }
      if (action !== 'toggle') return { ok: false, error: 'bad-action' }
      const turningOn = !reactGrabOn.has(guest.id)
      try {
        await guest.executeJavaScript(turningOn ? REACT_GRAB_ON_JS : REACT_GRAB_OFF_JS, true)
      } catch (e) {
        return { ok: false, error: 'eval-failed', message: errMessage(e) }
      }
      if (turningOn) reactGrabOn.add(guest.id)
      else reactGrabOn.delete(guest.id)
      return { ok: true, on: turningOn }
    },
  })
}

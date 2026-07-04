/**
 * `browse` toolbelt service (agent-toolbelt #8, capability 'browse' — elevated: driving the
 * embedded browser is system-facing, unlike the pane-scoped defaults). Lets an agent (via the
 * `pine browse ...` CLI → control socket) read/click/type/screenshot/eval against the guest
 * page loaded in Stage 1's `browser` surface (`src/renderer/components/BrowserView.tsx`'s
 * `<webview>`).
 *
 * The guest page runs in its own OS process (Electron `<webview>`'s isolated guest), so main
 * can only reach it via its `webContents` — which the renderer hands over on `dom-ready`
 * (`browser:register` IPC, wired in `index.ts`) since only main can resolve a webContents id
 * back into an actual `WebContents` handle. `browserPanes` (renderer paneId → guest
 * webContents id) is owned by `index.ts` and injected here (not imported) to avoid the same
 * import cycle `controlServer.ts` avoids with `ControlServerDeps`.
 *
 * Target resolution (`resolveGuest`): an explicit `paneId` is an EXTERNAL id (e.g. relayed by
 * another agent via `pine wiki`/`pine bus`, mirroring the "no pane.list yet" coordination
 * recipe in `.claude/skills/pine/SKILL.md`) — resolved via `idRegistry.resolveExternal`. With
 * no `paneId`, this defaults to the first browser pane registered under the caller's own
 * session. Every method fails with a typed `{ ok: false, error }` (never throws) so a bad
 * selector or a not-yet-loaded page degrades gracefully instead of killing the caller's script.
 *
 * `executeJavaScript` runs arbitrary agent-supplied selectors/JS in the guest page — that's the
 * point of an elevated `browse` capability, not a bug. The only defensive measure needed is
 * JSON-encoding every agent-supplied string INTO the script text (`JSON.stringify`) so it can't
 * break out of the generated JS and inject something unintended.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { webContents } from 'electron'
import type { CommandResult, CommandTarget } from '../shared/types'
import { type AuthedConn, connHasCap } from './controlAuth'
import { registerControlMethod } from './controlServer'
import { type PaneIdentity, getByPaneId, resolveExternal } from './idRegistry'
import { resolveSafe } from './pathGuard'

type MethodCtx = { identity: PaneIdentity; authed: AuthedConn }

/**
 * `index.ts` owns the pane-registry + command bridge, so (same as `ControlServerDeps`) this
 * must be handed over rather than imported, or `index.ts` importing this module would cycle.
 */
export interface BrowseDeps {
  /** Renderer paneId → guest webContents id, maintained by `browser:register`/`unregister`. */
  browserPanes: Map<string, number>
  /** Reused from the command bridge so `browse.open` can spin up a pane via `browser.new`. */
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  /** Allow-list roots for `browse.screenshot`'s caller-supplied `path` (mirrors `fs:*`'s). */
  screenshotRoots: string[]
}

type GuestResolution =
  | { ok: true; guest: Electron.WebContents; rendererPaneId: string }
  | { ok: false; error: 'no-browser-pane' }
  | { ok: false; error: 'browser-not-ready' }
  | { ok: false; error: 'needs-elevation' }

/**
 * Resolve the guest `WebContents` a `browse.*` call should act on.
 * - `paneId` given (an external id): must resolve to a known pane; that pane must have
 *   registered a live guest (else `browser-not-ready` — it exists but hasn't `dom-ready`'d, or
 *   isn't a browser pane at all... either way nothing to drive yet). If that pane lives in a
 *   different session/window than the caller's own, driving it is a cross-boundary action —
 *   same trust posture as `command.exec`'s cross-pane gate — so it additionally requires the
 *   elevated `workspace-wide` capability (else `needs-elevation`).
 * - `paneId` omitted: the first registered browser pane belonging to the caller's own session
 *   (never cross-boundary, so no elevation check applies here).
 */
function resolveGuest(deps: BrowseDeps, ctx: MethodCtx, paneId?: string): GuestResolution {
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

/** `String(err)` for a caught exception, without the `Error: ` prefix `.message` already omits. */
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const MAX_HTML_CHARS = 1_000_000

/** Per-pane sequence so `browse.screenshot`'s scratch filenames never collide. */
const screenshotCounters = new Map<string, number>()

function scratchScreenshotPath(rendererPaneId: string): string {
  const n = (screenshotCounters.get(rendererPaneId) ?? 0) + 1
  screenshotCounters.set(rendererPaneId, n)
  return join(tmpdir(), 'pine-screens', `${rendererPaneId}-${n}.png`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Maps DOM `KeyboardEvent.key` names (plus a couple of common aliases) to the Electron
 * Accelerator key-code strings `sendInputEvent` expects — the two vocabularies mostly agree
 * (letters, digits, 'Tab', 'Escape', function keys, ...) but diverge for a handful of the keys
 * agents reach for most (arrows, Enter, Space).
 */
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

/**
 * True for a single-character key ('a', '5', '!', ...) — these also need a synthetic `char`
 * input event to actually insert a character into a focused input/contenteditable; named keys
 * (Enter, Tab, arrows, function keys, ...) have no character to insert.
 */
function isPrintableKey(key: string): boolean {
  return [...key].length === 1
}

/** `keyDown` (+ a `char` event for a printable key) — what `sendInputEvent` needs to simulate a
 *  key actually being typed, not just a raw scan code. Mirrored by `browse.press`'s `keyUp`. */
function sendKeyDown(guest: Electron.WebContents, key: string): void {
  guest.sendInputEvent({ type: 'keyDown', keyCode: toElectronKeyCode(key) })
  if (isPrintableKey(key)) {
    guest.sendInputEvent({ type: 'char', keyCode: key })
  }
}

function sendKeyUp(guest: Electron.WebContents, key: string): void {
  guest.sendInputEvent({ type: 'keyUp', keyCode: toElectronKeyCode(key) })
}

/**
 * Idempotent injected-page helper — `executeJavaScript` runs in the live guest page and
 * `window.__pine` survives until the next navigation, so refs a `snapshot`/`find` call assigns
 * are still readable by a later call in the same page lifetime. Guarded by `if (!window.__pine)`
 * so re-running this prelude on every call (cheap — it's the point) never resets `refs`/`n`.
 *
 * `resolveEl(sel)` is what makes every selector-accepting method below "ref-aware": a bare
 * `eN`/`@eN` string looks up the stored element directly (no DOM query at all — the whole point
 * of a ref, since the element may no longer be reachable by any selector, e.g. it lost an id),
 * anything else falls through to `document.querySelector`. `roleOf`/`nameOf` are the shared
 * accessible-role/name heuristics `browse.snapshot` and `browse.find` both need (kept on
 * `window.__pine` rather than duplicated in each method's generated JS).
 */
const ENSURE_INJECTED = `
if (!window.__pine) {
  window.__pine = {
    refs: {},
    n: 0,
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
      return sel ? document.querySelector(sel) : null;
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

/** Wrap a JS function body in the injected-page prelude + an IIFE — every generated snippet
 *  that calls `window.__pine.resolveEl`/`ref`/`roleOf`/`nameOf` needs this, not just the raw
 *  IIFE, so refs stay valid and `@eN` resolves the same way everywhere. */
function withInjected(body: string): string {
  return `${ENSURE_INJECTED}\n(() => {\n${body}\n})()`
}

/**
 * Run a `resolveEl`-shaped IIFE (built via `withInjected`) that returns `true`/`false` for "did
 * the selector/ref match" (any DOM mutation/event dispatch already baked into `js` by the
 * caller), translating that into `browse`'s standard not-found/eval-failed result shape. Factors
 * out the reduction `browse.click`/`browse.type` above hand-roll — worth it here since most of
 * the DOM-interaction methods below are exactly this shape.
 */
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

/** `resolveEl(sel)?.focus()` — shared by `browse.focus` and the selector-first step of
 *  `browse.press`/`browse.keydown`/`browse.keyup`. Ref-aware like every other selector method. */
function focusSelectorJs(selector: string): string {
  return withInjected(`
    const el = window.__pine.resolveEl(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    return true;
  `)
}

/** Hard cap on `browse.snapshot`'s emitted node count — keeps the result bounded on a huge page
 *  instead of walking (and ref-ing) tens of thousands of elements. */
const MAX_SNAPSHOT_NODES = 2000
/** Default/hard-cap DOM depth `browse.snapshot` will recurse — a caller-supplied `maxDepth` is
 *  clamped to this so a pathological DOM can't blow the walk's recursion budget. */
const DEFAULT_SNAPSHOT_MAX_DEPTH = 40
const MAX_SNAPSHOT_MAX_DEPTH = 200

export function registerBrowseMethods(deps: BrowseDeps): void {
  registerControlMethod('browse.open', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { url, paneId } = (params ?? {}) as { url: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (resolution.ok) {
        resolution.guest.loadURL(url)
        // Hand back the target pane's externalId (not the internal renderer paneId) so a
        // caller that didn't pass `--pane` can target this same pane on a follow-up call.
        return { ok: true, paneId: getByPaneId(resolution.rendererPaneId)?.externalId }
      }
      // No live guest to drive (none exists yet, or it hasn't dom-ready'd) — spin one up in
      // the CALLER's own session via the existing `browser.new` command (Stage 1), same as a
      // human running `pine open`/the command palette would.
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
      // Set via the native value setter (not plain `el.value = ...`) so React/Vue-controlled
      // inputs — which override the `value` property descriptor to intercept writes — still
      // see the change; the `input` event afterwards is what actually notifies them.
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

  // `browse.check`/`browse.uncheck` are identical apart from the boolean they set — a tiny
  // factory instead of two near-duplicate handlers.
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
      // Whole-value replace via plain `el.value =` — unlike `browse.type`'s native-setter dance,
      // this doesn't fight a React/Vue value-property override; it's for plain inputs where a
      // direct set is all that's needed.
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
      // Set by option value first; if nothing matched (`.value` didn't stick — invalid for this
      // <select>), fall back to matching an option's visible text.
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
      try {
        const raw = await resolution.guest.executeJavaScript(js, true)
        // Stringify safely — the raw value may not be JSON (undefined, a function, a DOM
        // node reference that survived the guest's structured clone, ...) — fall back to
        // String() rather than letting a serialization error look like the script itself
        // failed.
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
        } catch {
          // Transient — often mid-navigation. Keep polling until the deadline.
        }
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
        // No caller-supplied path — the scratch default, always under the OS tmpdir, needs no
        // allow-list check.
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

  // --- Inspection family (cmux parity): snapshot/get/is/find/highlight, all `eN`-ref-aware. ---

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
      // Walks the DOM assigning a ref to every "relevant" element (interactive controls always;
      // headings/[role]/own-text elements too unless `interactive` narrows it to actionable-only),
      // emitting an accessibility-tree-ish line per ref. Indentation tracks nesting of *emitted*
      // ancestors (not raw DOM depth) so wrapper divs don't blow out the tree's shape; `rawDepth`
      // still bounds recursion via `maxDepth` regardless of what got emitted.
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
      // Every branch returns `{found, value}` uniformly so the TS side doesn't need per-sub
      // shape-sniffing to tell "element missing" apart from "attribute legitimately null" etc.
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
      // Testing-Library-ish locators: `role`/`text` scan the scope for a matching element (via
      // the shared `roleOf` heuristic, or own/inner text); `label` tries `<label for>` first, then
      // falls back to `aria-label`; `placeholder`/`alt`/`title`/`testid` match the like-named
      // attribute; `first`/`last`/`nth` enumerate `selector` directly on `document` (not scoped —
      // `selector` IS the enumeration, matching the CLI's literal "over `selector`" contract).
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
}

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
 * Run a `document.querySelector`-shaped IIFE that returns `true`/`false` for "did the selector
 * match" (any DOM mutation/event dispatch already baked into `js` by the caller), translating
 * that into `browse`'s standard not-found/eval-failed result shape. Factors out the reduction
 * `browse.click`/`browse.type` above hand-roll — worth it here since most of the DOM-interaction
 * methods below are exactly this shape.
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

/** `document.querySelector(sel)?.focus()` — shared by `browse.focus` and the selector-first
 *  step of `browse.press`/`browse.keydown`/`browse.keyup`. */
function focusSelectorJs(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    return true;
  })()`
}

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
      const js = `(() => {
        const sel = ${selJs};
        if (sel) { const el = document.querySelector(sel); return el ? el.innerText : ''; }
        return document.body ? document.body.innerText : '';
      })()`
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
      const js = `(() => {
        const el = document.querySelector(${selJs});
        if (!el) return false;
        el.click();
        return true;
      })()`
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
      const js = `(() => {
        const el = document.querySelector(${selJs});
        if (!el) return false;
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${textJs}); else el.value = ${textJs};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`
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
      const js = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click?.();
        el.click?.();
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return true;
      })()`
      return runSelectorJs(resolution.guest, js)
    },
  })

  registerControlMethod('browse.hover', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { selector, paneId } = (params ?? {}) as { selector: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const js = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const opts = { bubbles: true };
        el.dispatchEvent(new MouseEvent('mouseover', opts));
        el.dispatchEvent(new MouseEvent('mouseenter', opts));
        el.dispatchEvent(new MouseEvent('mousemove', opts));
        return true;
      })()`
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
        const js = `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          el.checked = ${checked};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`
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
      const js = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        return true;
      })()`
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
      const js = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`
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
      const js = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.value = ${valueJs};
        if (el.value !== ${valueJs}) {
          for (const opt of Array.from(el.options || [])) {
            if (opt.textContent.trim() === ${valueJs}) { el.value = opt.value; break; }
          }
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`
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
        ? `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            el.scrollBy(${xJs}, ${yJs});
            return true;
          })()`
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
      const js = `!!document.querySelector(${selJs})`
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
}

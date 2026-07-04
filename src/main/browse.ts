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
 * Target resolution (`resolveGuest`): an explicit `paneId` is an EXTERNAL id (e.g. read from
 * `pine pane.list`, or relayed by another agent via `pine wiki`/`pine bus` — see the
 * coordination recipe in `.claude/skills/pine/SKILL.md`) — resolved via `idRegistry.resolveExternal`. With
 * no `paneId`, this defaults to the first browser pane registered under the caller's own
 * session. Every method fails with a typed `{ ok: false, error }` (never throws) so a bad
 * selector or a not-yet-loaded page degrades gracefully instead of killing the caller's script.
 *
 * `executeJavaScript` runs arbitrary agent-supplied selectors/JS in the guest page — that's the
 * point of an elevated `browse` capability, not a bug. The only defensive measure needed is
 * JSON-encoding every agent-supplied string INTO the script text (`JSON.stringify`) so it can't
 * break out of the generated JS and inject something unintended.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  /** Reused from the command bridge so `browse.open`/`browse.openSplit` can spin up a pane via
   *  `browser.new`. */
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  /** Allow-list roots for `browse.screenshot`'s caller-supplied `path` (mirrors `fs:*`'s). */
  screenshotRoots: string[]
  /** Per-guest-webContents-id ring buffer of every `console-message` (see `pushConsoleEntry`),
   *  populated by `index.ts`'s `browser:register`-attached listener. Read/cleared by
   *  `browse.console`. */
  consoleBuffers: Map<number, ConsoleEntry[]>
  /** Same shape as `consoleBuffers`, but only the error-level / `[pine-error]`-tagged subset
   *  (uncaught exceptions/rejections included, via the injected `PAGE_ERROR_CATCHER_JS`). Read/
   *  cleared by `browse.errors`. */
  errorBuffers: Map<number, ConsoleEntry[]>
}

/** One buffered `console-message` entry. */
export interface ConsoleEntry {
  level: string
  text: string
  ts: number
}

/** Ring-buffer cap per surface — bounds memory on a page that logs constantly. */
export const MAX_CONSOLE_ENTRIES = 500

/**
 * Push `entry` onto `buffer`'s per-guest ring buffer (creating it on first use), trimming to
 * `MAX_CONSOLE_ENTRIES` FIFO. Called from `index.ts`'s `console-message` listener for both the
 * console buffer (every message) and the error buffer (error-level / `[pine-error]`-tagged only).
 */
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

/** Electron's numeric `console-message` level (0-3) as the string cmux/agents expect. */
export function consoleLevelName(level: number): string {
  return (['verbose', 'info', 'warning', 'error'] as const)[level] ?? 'info'
}

/** Marker prefix the injected error catcher (`PAGE_ERROR_CATCHER_JS`) puts on its
 *  `console.error(...)` calls, so `index.ts`'s `console-message` listener can route an otherwise
 *  ordinary-looking error-level message into the error buffer unambiguously. */
export const PINE_ERROR_PREFIX = '[pine-error]'

/**
 * CDP-injected (`Page.addScriptToEvaluateOnNewDocument`, the same mechanism `browse.addinitscript`
 * exposes to callers) catcher for otherwise-invisible page errors: an uncaught exception or an
 * unhandled promise rejection never reaches `console-message` on its own, so without this,
 * `browse.errors` would only ever see explicit `console.error(...)` calls a page happened to make.
 * `index.ts` attaches this once per guest webContents (`browser:register`). Idempotency-guarded
 * (`window.__pineErrCatcher`) since `addScriptToEvaluateOnNewDocument` reruns at the start of
 * EVERY future navigation, and `browser:register` itself can refire (dom-ready fires again on
 * each navigation of the same long-lived webview) — without the guard a script that's navigated a
 * few times would stack duplicate `onerror`/`onunhandledrejection` handlers.
 */
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

/**
 * Per-guest-webContents-id "current frame" selector for `browse.frame` — Node-side bookkeeping
 * mirroring the in-page `window.__pine.frameSel` state (see `ENSURE_INJECTED`'s `resolveEl`,
 * which is what actually makes selector-driven methods frame-aware). Cleared alongside the
 * console/error buffers on `browser:unregister`/pane close (`clearGuestFrame`).
 */
const frameSelectors = new Map<number, string>()

/** Drop any tracked frame pointer for a guest that's gone — called by `index.ts` next to its
 *  `consoleBuffers`/`errorBuffers` cleanup on `browser:unregister` and the window-close ghost
 *  reap. Harmless if none was set. */
export function clearGuestFrame(wcId: number): void {
  frameSelectors.delete(wcId)
}

/**
 * Per-guest-webContents-id auto-response policy for `browse.dialog` (cmux parity, PRAGMATIC:
 * Electron's `<webview>` guest can't intercept a page's SYNCHRONOUS `confirm`/`prompt` the way a
 * real automation framework's `page.on('dialog', ...)` does, so instead of a one-at-a-time
 * blocking queue this is a standing "how should the next alert/confirm/prompt resolve" policy an
 * agent sets ahead of time — see `DIALOG_OVERRIDE_JS`'s header comment for the full divergence).
 * Kept here so a caller could inspect the CURRENT policy without round-tripping into the guest
 * page; live enforcement is entirely page-side (`window.__pineDialogPolicy`, pushed by
 * `browse.dialog`'s handler).
 */
const dialogPolicies = new Map<number, { policy: 'accept' | 'dismiss'; text: string | null }>()

/** Per-guest CDP-attach guard for the dialog override — `DIALOG_OVERRIDE_JS` is itself
 *  idempotent (`window.__pineDialogPatched`), so this only avoids piling up redundant
 *  `Page.addScriptToEvaluateOnNewDocument` registrations on every `browse.dialog accept/dismiss`
 *  call against the same surface. */
const dialogInitAttached = new Set<number>()

/** Drop a guest's dialog policy/attach bookkeeping — called by `index.ts` alongside
 *  `clearGuestFrame` on `browser:unregister` and the window-close ghost reap. */
export function clearGuestDialogPolicy(wcId: number): void {
  dialogPolicies.delete(wcId)
  dialogInitAttached.delete(wcId)
}

/** Per-guest "is the react-grab click-catcher installed" flag for `browse.reactGrab` — a
 *  main-side mirror of the page's own `window.__pineReactGrabOn`, so `toggle` knows which script
 *  (install vs. remove) to run without a read round-trip first. */
const reactGrabOn = new Set<number>()

/** Drop a guest's react-grab bookkeeping — called alongside `clearGuestDialogPolicy` above. */
export function clearGuestReactGrab(wcId: number): void {
  reactGrabOn.delete(wcId)
}

/** Ring-buffer cap for `window.__pineDialogs` (mirrors `MAX_CONSOLE_ENTRIES`) — bounds memory on
 *  a page that calls `alert()` in a loop. */
const MAX_DIALOG_ENTRIES = 200

/**
 * CDP-injected (same mechanism as `PAGE_ERROR_CATCHER_JS`/`browse.addinitscript`, via
 * `cdpAddInitScript`) monkeypatch for `browse.dialog`: overrides `alert`/`confirm`/`prompt`
 * directly in the page since Electron's `<webview>` guest has no clean synchronous-dialog
 * interception hook. Every call is logged to `window.__pineDialogs` (capped, FIFO);
 * `confirm`/`prompt` additionally resolve against `window.__pineDialogPolicy`
 * (`{policy:'accept'|'dismiss', text}`) instead of actually blocking — an auto-response POLICY,
 * not a one-at-a-time queue (the documented cmux divergence). Idempotency-guarded
 * (`window.__pineDialogPatched`) the same way `PAGE_ERROR_CATCHER_JS` is, since this reruns on
 * every future navigation once persisted via CDP. NOTE: `window.__pineDialogPolicy` is only ever
 * seeded with a SAFE default (dismiss/null) by this script — it does not durably survive
 * navigation with whatever an agent last set via `browse.dialog accept|dismiss`, since a fresh
 * page load is a fresh JS context; re-call `accept`/`dismiss` after navigating if a non-default
 * policy still needs to apply.
 */
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

/**
 * `browse.reactGrab`'s click-catcher (cmux parity, MINIMAL — a small fiber walk, not the
 * upstream react-grab overlay/UI). Installed via plain `executeJavaScript`, NOT the CDP
 * init-script mechanism above — this is a live, one-page-view inspection tool, not something
 * meant to persist across navigations, so a navigation silently drops it (call `toggle` again
 * after navigating if still wanted). On click, walks up from the clicked element to find a React
 * fiber (`__reactFiber$*`/`__reactInternalInstance$*` — React's own DOM-node→fiber pointer key
 * prefixes), then walks the fiber's `return` chain to the nearest fiber whose `type` is a
 * function/class (a component, not a host element like a `div`), reporting its name +
 * `_debugSource` (only present in dev builds compiled with a "add JSX source" Babel/SWC plugin —
 * absent in production builds, hence best-effort/often null).
 */
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

/** Uninstalls `REACT_GRAB_ON_JS`'s click handler — a no-op if it was never installed (or the
 *  page navigated since, which already dropped it). */
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

/**
 * Run `js` in the guest page and hand back its value JSON-stringified into a text result —
 * shared by `browse.eval` and `browse.addscript` (same "run script now, return its value"
 * semantics; `addscript` is just framed as script injection for cmux parity, not a different
 * execution mode).
 */
async function evalToResult(
  guest: Electron.WebContents,
  js: string,
): Promise<{ ok: true; result: string } | { ok: false; error: string; message?: string }> {
  try {
    const raw = await guest.executeJavaScript(js, true)
    // Stringify safely — the raw value may not be JSON (undefined, a function, a DOM node
    // reference that survived the guest's structured clone, ...) — fall back to String()
    // rather than letting a serialization error look like the script itself failed.
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

/**
 * Build a `url` for a cookie that has none (every cookie from `session.cookies.get` carries
 * `domain`/`path`/`secure` but never a `url`) — needed by `browse.cookies clear` to remove a
 * `get`-matched cookie via `cookies.remove(url, name)`, and by `browse.state load` to restore
 * saved cookies via `cookies.set`. Chrome normalises `domain` with a leading dot (valid for
 * subdomains); strip it back off since `url`'s host can't have one.
 */
function cookieUrl(cookie: Electron.Cookie): string {
  const domain = (cookie.domain ?? '').replace(/^\./, '')
  return `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path ?? '/'}`
}

/** Persisted shape for `browse.state save`/`load` — cookies plus both Web Storage areas. */
interface BrowseStateFile {
  cookies: Electron.Cookie[]
  localStorage: Record<string, string>
  sessionStorage: Record<string, string>
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

/**
 * Attach (if not already) a CDP debugger session on `guest` and persist `js` via
 * `Page.addScriptToEvaluateOnNewDocument`, so it reruns before every FUTURE navigation. Shared
 * plumbing behind `browse.addinitscript` (agent-supplied init scripts) and `browse.dialog`'s
 * alert/confirm/prompt override — the brief for the latter explicitly says to reuse this
 * mechanism rather than invent a second one.
 */
async function cdpAddInitScript(
  guest: Electron.WebContents,
  js: string,
): Promise<{ ok: true; identifier: string } | { ok: false; error: string; message?: string }> {
  try {
    // `isAttached()` is Electron's own per-webContents bookkeeping for whether a CDP
    // session is already live — checking it before `attach()` IS "tracking attached
    // surfaces": a separate map here would just duplicate state Electron already keeps,
    // and (since nothing awaits between the check and the call) can't race.
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

  // --- Navigation/targeting family (cmux parity): url/zoom/devtools/focus-webview/identify. ---

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
      // Electron's DevTools API can only open/close the whole panel — there's no hook to land
      // on a specific tab (Console, Elements, ...), so `console` opens DevTools same as `open`
      // and says so rather than silently pretending it focused the Console panel.
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
      // `resolveGuest` already proved this renderer paneId is registered, but `getByPaneId`
      // is a separate map (identity registry vs. browser-pane registry) — still check.
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

  // --- Session/state family (cmux parity): cookies/storage/state/history, all per-surface —
  // every browser pane already has its own `partition` (`BrowserView.tsx`), so `guest.session`
  // here is that pane's own isolated cookie/storage jar, never shared across panes. ---

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
          // No filter at all — remove every cookie in this surface's jar in one shot rather
          // than round-tripping a `get` + N `remove`s.
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
      // Arbitrary file read/write — same containment `browse.screenshot` applies to its
      // caller-supplied `path`.
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
      // `navigationHistory` is the modern (Electron 32+) API; `clearHistory()` is its
      // deprecated predecessor, kept as a runtime fallback in case this ever runs on an older
      // Electron than the one currently pinned (`navigationHistory` unconditional there).
      if (typeof guest.navigationHistory?.clear === 'function') {
        guest.navigationHistory.clear()
      } else {
        guest.clearHistory()
      }
      return { ok: true }
    },
  })

  // --- Injection family (cmux parity): addscript/addstyle/addinitscript, alongside `browse.eval`. ---

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

  // --- Diagnostics family (cmux parity): console/errors, the read side of `index.ts`'s
  // `browser:register`-attached `console-message` listener + injected `PAGE_ERROR_CATCHER_JS`. ---

  // `browse.console`/`browse.errors` are identical apart from which per-guest ring buffer they
  // read/clear — a small factory, same idea as `registerCheckMethod` above.
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

  // --- Frame family (cmux parity): a stateful "current frame" pointer that selector-driven
  // methods (via `resolveEl`/`frameDoc` in `ENSURE_INJECTED`) resolve within, instead of always
  // the top document. ---

  registerControlMethod('browse.frame', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { selector, paneId } = (params ?? {}) as { selector?: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      const { guest } = resolution
      const isReset = !selector || selector === 'main' || selector === 'top'
      const selJs = JSON.stringify(isReset ? null : selector)
      // Validated (and applied) in a single injected round-trip: resolve `sel` against the top
      // document, confirm it's an iframe whose `contentDocument` is actually reachable (null for
      // a cross-origin frame — no throw in modern engines, but wrapped in try/catch anyway per
      // the brief), then persist it onto `window.__pine.frameSel` so `resolveEl` picks it up on
      // every later call without needing this script re-run.
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

  // --- Download family (cmux parity): one-shot wait for the surface's next completed download. ---

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
            } catch {
              // best-effort — a bad target dir still surfaces via the download's own `state`
            }
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

  // --- Aliases (cmux parity): `navigate` (load a url on an EXISTING surface, no auto-create) and
  // `openSplit` (always creates a NEW browser pane — the split `browse.open`'s fallback path
  // creates when no surface exists yet, exposed here as its own explicit verb). ---

  registerControlMethod('browse.navigate', {
    cap: 'browse',
    handler: (params, ctx) => {
      const { url, paneId } = (params ?? {}) as { url: string; paneId?: string }
      const resolution = resolveGuest(deps, ctx, paneId)
      if (!resolution.ok) return resolution
      resolution.guest.loadURL(url)
      return { ok: true, paneId: getByPaneId(resolution.rendererPaneId)?.externalId }
    },
  })

  registerControlMethod('browse.openSplit', {
    cap: 'browse',
    handler: async (params, ctx) => {
      // Always creates a NEW browser pane (a split) — there's no existing surface to resolve to,
      // so a caller-supplied `paneId` isn't meaningful here; accepted (for CLI `--pane` flag
      // symmetry with every other `browse.*` verb) but otherwise unused.
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

  // --- Tab family (cmux parity, PRAGMATIC: a "tab" here is a browser PANE, not a tab bar living
  // inside one pane — cmux multiplexes multiple surfaces per pane slot; Pine's own unit of
  // multiplexing is already the pane, so `tab new/list/switch/close` just operate one level up,
  // on browser panes, instead of a second tab layer nested inside a single pane. ---

  registerControlMethod('browse.tab', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { sub, url, target } = (params ?? {}) as {
        sub: 'new' | 'list' | 'switch' | 'close'
        url?: string
        target?: string
      }
      if (sub === 'new') {
        // Same fallback `browse.open` uses for "no live guest yet" — `browser.new` REUSES an
        // existing browser pane in the caller's session if there is one (`openBrowser`'s own
        // reuse-or-split logic), so this isn't a guaranteed-fresh tab; use `browse.openSplit`
        // for an unconditionally new browser pane.
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
        // Scoped to the caller's own session — same posture `resolveGuest`'s no-`paneId`
        // default uses; listing another session's panes would be a cross-boundary read this
        // verb doesn't offer.
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
        // `target` is an external paneId (another pane's `whoami` id) — reuse `resolveGuest` for
        // its lookup + the same cross-boundary `workspace-wide` elevation gate every other
        // explicit-`paneId` call gets, even though we don't need the guest itself here.
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

  // --- Dialog family (cmux parity, PRAGMATIC: policy-based auto-answer, not a one-at-a-time
  // blocking queue — see `DIALOG_OVERRIDE_JS`'s header comment for why). ---

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
        // Apply to the CURRENTLY loaded page too — the CDP registration above only takes effect
        // on the NEXT navigation, not the page already showing.
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

  // --- Focus-mode family (cmux parity: pane zoom/zen). Drives the renderer's `pane.zoom`
  // command (`layoutStore.ts`) on the TARGET pane's own window/session — same cross-boundary
  // resolution `browse.tab switch/close` uses above. ---

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
      // `zoom` omitted → `pane.zoom`'s own toggle; enter/exit pass an explicit boolean so they're
      // deterministic regardless of the pane's current zoom state (main has no visibility into
      // the renderer's layout state to check first).
      const zoom = action === 'enter' ? true : action === 'exit' ? false : undefined
      const res = await deps.execCommand(cmdTarget, 'pane.zoom', { paneId: identity.paneId, zoom })
      if (!res.ok) return { ok: false, error: 'command-failed', message: res.error.message }
      return { ok: true }
    },
  })

  // --- React-grab family (cmux parity, MINIMAL — a small fiber walk, not the upstream
  // react-grab overlay; see `REACT_GRAB_ON_JS`'s header comment). ---

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

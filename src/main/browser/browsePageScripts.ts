import { debuggerCommand } from './browseMethod'

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

export interface PageScriptDebugger {
  on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown
  sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>
}

const IFRAME_AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: 'iframe' }],
}

const followedDebuggers = new WeakSet<PageScriptDebugger>()

export function injectPageScripts(
  guest: { debugger: PageScriptDebugger },
  sources: readonly string[],
): Promise<void> {
  const dbg = guest.debugger
  const send = (method: string, params: object, sessionId?: string): Promise<unknown> => {
    try {
      const sent =
        sessionId === undefined
          ? dbg.sendCommand(method, params)
          : dbg.sendCommand(method, params, sessionId)
      return sent.catch(() => {})
    } catch {
      return Promise.resolve()
    }
  }
  const prepare = (sessionId?: string): Promise<void> => {
    void send('Page.enable', {}, sessionId)
    const registered = sources.map((source) =>
      send('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true }, sessionId),
    )
    void send('Target.setAutoAttach', IFRAME_AUTO_ATTACH, sessionId)
    return Promise.all(registered).then(() => {})
  }
  if (!followedDebuggers.has(dbg)) {
    followedDebuggers.add(dbg)
    dbg.on('message', (_event, method, params) => {
      if (method !== 'Target.attachedToTarget') return
      const { sessionId, targetInfo } = (params ?? {}) as {
        sessionId?: unknown
        targetInfo?: { type?: unknown }
      }
      if (typeof sessionId !== 'string' || sessionId === '') return
      const isFrame = targetInfo?.type === 'iframe'
      setImmediate(() => {
        if (isFrame) void prepare(sessionId)
        void send('Runtime.runIfWaitingForDebugger', {}, sessionId)
      })
    })
  }
  return prepare()
}

const MAX_DIALOG_ENTRIES = 200

export const DIALOG_OVERRIDE_JS = `(() => {
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

export const REACT_GRAB_ON_JS = `(() => {
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

export const REACT_GRAB_OFF_JS = `(() => {
  if (!window.__ostiaReactGrabOn) return true;
  window.__ostiaReactGrabOn = false;
  if (window.__ostiaReactGrabHandler) {
    document.removeEventListener('click', window.__ostiaReactGrabHandler, true);
  }
  return true;
})();`

export async function addInitScript(
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

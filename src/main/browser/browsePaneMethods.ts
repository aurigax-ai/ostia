import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getByPaneId } from '../control/idRegistry'
import type { BrowseState } from './browseGuests'
import {
  type BrowseDeps,
  type BrowseMethod,
  clampTimeout,
  commandTarget,
  debuggerCommand,
  fail,
  safeOutPath,
  str,
} from './browseMethod'
import { addInitScript, REACT_GRAB_OFF_JS, REACT_GRAB_ON_JS } from './browsePageScripts'

interface PaneDeps extends Pick<BrowseDeps, 'execCommand' | 'screenshotRoots'> {
  method: BrowseMethod
  state: BrowseState
}

export function registerBrowsePaneMethods(deps: PaneDeps): void {
  const { method } = deps
  const { reactGrabOn } = deps.state

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

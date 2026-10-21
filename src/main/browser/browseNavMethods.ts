import { normalizeUrl } from '../../shared/browser/browseInput'
import { registerTargetableMethod } from '../control/controlServer'
import { getByPaneId } from '../control/idRegistry'
import { type BrowseState, resolveGuest } from './browseGuests'
import {
  type BrowseDeps,
  type BrowseMethod,
  commandTarget,
  fail,
  type OpenTab,
  type Params,
  str,
} from './browseMethod'
import { runInBrowseWorld } from './browseWorld'

interface NavDeps
  extends Pick<
    BrowseDeps,
    'browserPanes' | 'isSharedPane' | 'reach' | 'execCommand' | 'allowNavigation'
  > {
  method: BrowseMethod
  state: BrowseState
  openTab: OpenTab
}

export function registerBrowseNavMethods(deps: NavDeps): void {
  const { method, openTab } = deps
  const { activeTabs } = deps.state

  registerTargetableMethod('browse.open', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const p = (params ?? {}) as Params
      const raw = str(p.url)
      const url = raw ? normalizeUrl(raw) : undefined
      if (url && !(await deps.allowNavigation(ctx.identity.workspaceId, url))) {
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
}

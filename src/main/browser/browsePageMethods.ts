import { readFileSync } from 'node:fs'
import { normalizeUrl } from '../../shared/browser/browseInput'
import type { WebStorageDump } from '../../shared/browser/browseRuntime'
import type { StorageCookie } from '../../shared/browser/browserStorage'
import { registerTargetableMethod } from '../control/controlServer'
import { getByPaneId } from '../control/idRegistry'
import { type BrowseState, defaultBrowserPane, liveGuest, resolveGuest } from './browseGuests'
import {
  type BrowseDeps,
  type BrowseMethod,
  type ConsoleEntry,
  commandTarget,
  fail,
  num,
  type OpenTab,
  type Params,
  safeOutPath,
  str,
  world,
  writeOut,
} from './browseMethod'
import { addInitScript, DIALOG_OVERRIDE_JS } from './browsePageScripts'
import { listCookies, readWebStorage, writeCookie } from './browserStorage'
import { jsArgs, runInBrowseWorld } from './browseWorld'

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

interface StateFile {
  cookies: StorageCookie[]
  localStorage: Record<string, string>
  sessionStorage: Record<string, string>
}

interface PageDeps
  extends Pick<
    BrowseDeps,
    | 'browserPanes'
    | 'isSharedPane'
    | 'reach'
    | 'execCommand'
    | 'screenshotRoots'
    | 'consoleBuffers'
    | 'errorBuffers'
  > {
  method: BrowseMethod
  state: BrowseState
  openTab: OpenTab
  workspaceBrowsers: (workspaceId: string) => Set<string>
}

export function registerBrowsePageMethods(deps: PageDeps): void {
  const { method, openTab, workspaceBrowsers } = deps
  const { activeTabs, dialogPolicies, dialogInitAttached } = deps.state

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
}

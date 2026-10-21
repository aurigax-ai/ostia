import { registerTargetableMethod } from '../control/controlServer'
import { getByPaneId } from '../control/idRegistry'
import { registerBrowseActionMethods } from './browseActionMethods'
import { registerBrowseDeviceMethods } from './browseDeviceMethods'
import { browseState, resolveGuest } from './browseGuests'
import { createBrowseInput } from './browseInput'
import {
  type BrowseDeps,
  type ConsoleEntry,
  commandTarget,
  errMessage,
  fail,
  type MethodCtx,
  type Params,
  str,
  waitFor,
} from './browseMethod'
import { registerBrowseNavMethods } from './browseNavMethods'
import { registerBrowsePageMethods } from './browsePageMethods'
import { registerBrowsePaneMethods } from './browsePaneMethods'
import { registerBrowseQueryMethods } from './browseQueryMethods'
import { registerBrowseStateMethods } from './browseStateMethods'
import { noteAgentDrive } from './guestPopups'

const MAX_CONSOLE_ENTRIES = 500
const NEW_TAB_WAIT_MS = 10_000

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
        } finally {
          noteAgentDrive(resolution.guest.id)
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

  const { activeTabs } = browseState

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

  const methodDeps = {
    ...deps,
    method,
    state: browseState,
    input: createBrowseInput(browseState),
    workspaceBrowsers,
    openTab,
  }
  registerBrowseNavMethods(methodDeps)
  registerBrowseActionMethods(methodDeps)
  registerBrowseQueryMethods(methodDeps)
  registerBrowseDeviceMethods(methodDeps)
  registerBrowseStateMethods(methodDeps)
  registerBrowsePageMethods(methodDeps)
  registerBrowsePaneMethods(methodDeps)
}

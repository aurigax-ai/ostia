import { ipcMain, shell } from 'electron'
import type { CommandResult, CommandTarget } from '../shared/types'
import { OPEN_VIEW_COMMAND, type ViewInfo } from '../shared/views'
import { targetOf } from './attention'
import { registerControlMethod } from './controlServer'
import type { ViewHost } from './viewHost'

export interface ViewsDeps {
  host: ViewHost
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
}

function summary(info: ViewInfo) {
  return {
    name: info.name,
    title: info.title,
    placement: info.placement,
    status: info.status,
    file: info.file,
    stale: info.stale,
    problems: info.problems,
  }
}

export function registerViewsIpc(host: ViewHost): void {
  ipcMain.handle('views:list', () => host.listing())
  ipcMain.handle('views:set-enabled', (_e, name: unknown, enabled: unknown) =>
    typeof name === 'string' && typeof enabled === 'boolean'
      ? host.setEnabled(name, enabled)
      : host.listing(),
  )
  ipcMain.handle('views:reveal', (_e, name: unknown) => {
    const path = typeof name === 'string' ? host.pathOf(name) : null
    if (!path) return false
    shell.showItemInFolder(path)
    return true
  })
}

export function registerViewMethods(deps: ViewsDeps): void {
  registerControlMethod('view.list', {
    cap: 'read-board',
    handler: () => {
      const listing = deps.host.listing()
      return { dir: listing.dir, views: listing.views.map(summary) }
    },
  })
  registerControlMethod('view.open', {
    cap: 'drive-self',
    handler: async (params: unknown, ctx) => {
      const name = (params as { name?: unknown } | null)?.name
      const info = typeof name === 'string' ? deps.host.info(name) : null
      if (!info)
        return { ok: false, error: 'not-found', message: `no view named '${String(name)}'` }
      if (info.status !== 'enabled') {
        return {
          ok: false,
          error: 'not-enabled',
          message: 'the human has not enabled this view (Settings → Views)',
        }
      }
      if (info.placement !== 'panel') {
        return {
          ok: false,
          error: 'not-a-panel',
          message: 'only placement "panel" views open as a pane',
        }
      }
      const res = await deps.execCommand(targetOf(ctx.identity), OPEN_VIEW_COMMAND, { name })
      return res.ok
        ? { ok: true }
        : { ok: false, error: res.error.code, message: res.error.message }
    },
  })
}

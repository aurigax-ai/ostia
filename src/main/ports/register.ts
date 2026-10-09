import { ipcMain } from 'electron'
import type { Capability } from '../../shared/capabilities'
import { ensureCaps } from '../approvals/controlElevation'
import { registerControlMethod } from '../control/controlServer'
import type { PortsService } from './service'

const READ_BOARD: Capability = 'read-board'
const ALL_WORKSPACES: Capability = 'all-workspaces'

export function registerPortsMethods(service: PortsService): void {
  registerControlMethod('ports.ls', {
    cap: READ_BOARD,
    handler: async (params, ctx) => {
      const all = (params as { all?: unknown } | null)?.all === true
      if (all) await ensureCaps(ctx.authed, ctx.identity, [ALL_WORKSPACES], 'ports.ls', '--all')
      const workspaceId = ctx.identity.workspaceId
      if (!all && !workspaceId) {
        return { ok: false, error: 'no-workspace', message: 'no workspace for this caller' }
      }
      const workspaces = (await service.list()).filter((w) => all || w.workspaceId === workspaceId)
      return { ok: true, data: { workspaces } }
    },
  })
}

export function registerPortsIpc(service: PortsService): void {
  ipcMain.on('ports:watch', (e, workspaceIds: unknown) => {
    service.watch(String(e.sender.id), workspaceIds)
  })
}

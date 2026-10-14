import { type IpcMainInvokeEvent, ipcMain } from 'electron'
import type { ExtensionConnectionEntry, ExtensionConnectionResult } from '../../shared/extensions'
import type { ExtensionHost } from './extensionHost'

function fromWindow(e: IpcMainInvokeEvent): boolean {
  return e.sender.getType() === 'window'
}

export function registerConnectionsIpc(host: () => ExtensionHost | null): void {
  ipcMain.handle('extensions:connections', (e, extId: unknown): ExtensionConnectionEntry[] => {
    if (!fromWindow(e)) return []
    return host()?.connectionsOf(String(extId)) ?? []
  })
  ipcMain.handle(
    'extensions:save-connection',
    (e, extId: unknown, req: unknown): ExtensionConnectionResult => {
      if (!fromWindow(e)) return { ok: false, error: 'not-a-window' }
      return host()?.saveConnection(String(extId), req) ?? { ok: false, error: 'unavailable' }
    },
  )
  ipcMain.handle(
    'extensions:remove-connection',
    (e, extId: unknown, name: unknown): ExtensionConnectionResult => {
      if (!fromWindow(e)) return { ok: false, error: 'not-a-window' }
      return host()?.removeConnection(String(extId), name) ?? { ok: false, error: 'unavailable' }
    },
  )
}

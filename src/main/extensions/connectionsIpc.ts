import type {
  ExtensionConnectionEntry,
  ExtensionConnectionResult,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { type IpcMainInvokeEvent, ipcMain } from 'electron'
import type { ExtensionConfig } from './extensionConfig'

function fromWindow(e: IpcMainInvokeEvent): boolean {
  return e.sender.getType() === 'window'
}

export function registerConnectionsIpc(config: () => ExtensionConfig | null): void {
  ipcMain.handle('extensions:connections', (e, extId: unknown): ExtensionConnectionEntry[] => {
    if (!fromWindow(e)) return []
    return config()?.connectionsOf(String(extId)) ?? []
  })
  ipcMain.handle(
    'extensions:save-connection',
    (e, extId: unknown, req: unknown): ExtensionConnectionResult => {
      if (!fromWindow(e)) return { ok: false, error: 'not-a-window' }
      return config()?.saveConnection(String(extId), req) ?? { ok: false, error: 'unavailable' }
    },
  )
  ipcMain.handle(
    'extensions:remove-connection',
    (e, extId: unknown, name: unknown): ExtensionConnectionResult => {
      if (!fromWindow(e)) return { ok: false, error: 'not-a-window' }
      return config()?.removeConnection(String(extId), name) ?? { ok: false, error: 'unavailable' }
    },
  )
}

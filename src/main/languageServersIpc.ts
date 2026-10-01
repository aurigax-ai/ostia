import { type WebContents, ipcMain } from 'electron'
import { type LanguageServerInfo, splitLanguageServerKey } from '../shared/languageServers'
import type { LanguageServers } from './languageServers'

export interface LanguageServersIpcDeps {
  servers: LanguageServers
  setEnabled: (extId: string, serverId: string, enabled: boolean) => void
}

export function registerLanguageServersIpc(deps: LanguageServersIpcDeps): void {
  const { servers } = deps
  const watched = new WeakSet<WebContents>()
  const watch = (sender: WebContents): void => {
    if (watched.has(sender)) return
    watched.add(sender)
    const windowId = String(sender.id)
    const drop = (): void => servers.dropWindow(windowId)
    sender.once('destroyed', drop)
    sender.on('render-process-gone', drop)
    sender.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) drop()
    })
  }

  ipcMain.handle('lsp:servers', (): LanguageServerInfo[] => servers.servers())
  ipcMain.handle('lsp:open', (e, paneId: unknown, filePath: unknown) => {
    watch(e.sender)
    return servers.open(String(e.sender.id), paneId, filePath)
  })
  ipcMain.on('lsp:send', (e, sessionId: unknown, message: unknown) =>
    servers.send(String(e.sender.id), sessionId, message),
  )
  ipcMain.on('lsp:release', (e, sessionId: unknown) =>
    servers.release(String(e.sender.id), sessionId),
  )
  ipcMain.handle('lsp:restart', (_e, key: unknown) => servers.restart(key))
  ipcMain.handle('lsp:log', (_e, key: unknown) => servers.log(key))
  ipcMain.handle('lsp:fetch', (_e, key: unknown) => servers.fetch(key))
  ipcMain.handle('lsp:remove-download', (_e, key: unknown) => servers.removeDownload(key))
  ipcMain.handle(
    'extensions:set-language-server',
    (_e, key: unknown, enabled: unknown): LanguageServerInfo[] => {
      const target = splitLanguageServerKey(key)
      if (target) deps.setEnabled(target.extId, target.serverId, enabled === true)
      return servers.servers()
    },
  )
}

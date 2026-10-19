import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const lspBridge: Pick<OstiaBridge, 'lsp' | 'editorLanguages'> = {
  lsp: {
    servers: () => ipcRenderer.invoke('lsp:servers'),
    onServersChanged: (cb) => listen('lsp:servers-changed', cb),
    open: (paneId, filePath) => ipcRenderer.invoke('lsp:open', paneId, filePath),
    send: (sessionId, message) => ipcRenderer.send('lsp:send', sessionId, message),
    release: (sessionId) => ipcRenderer.send('lsp:release', sessionId),
    onMessage: (sessionId, cb) => listen(`lsp:msg:${sessionId}`, cb),
    onExit: (sessionId, cb) => listen(`lsp:exit:${sessionId}`, () => cb()),
    setEnabled: (serverKey, enabled) =>
      ipcRenderer.invoke('extensions:set-language-server', serverKey, enabled),
    restart: (serverKey) => ipcRenderer.invoke('lsp:restart', serverKey),
    log: (serverKey) => ipcRenderer.invoke('lsp:log', serverKey),
    fetch: (serverKey) => ipcRenderer.invoke('lsp:fetch', serverKey),
    removeDownload: (serverKey) => ipcRenderer.invoke('lsp:remove-download', serverKey),
    setOverride: (serverKey, override) =>
      ipcRenderer.invoke('extensions:set-language-server-program', serverKey, override),
  },
  editorLanguages: {
    load: () => ipcRenderer.invoke('editorLanguages:load'),
  },
}

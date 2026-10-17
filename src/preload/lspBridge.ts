import type { EditorLanguage } from '@aurigax-ai/ostia-extension-sdk/contract/editorLanguages'
import type {
  LanguageServerInfo,
  LanguageServerOverrideResult,
  LspLog,
  LspSessionInfo,
} from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const lspBridge: Pick<OstiaBridge, 'lsp' | 'editorLanguages'> = {
  lsp: {
    servers: () => ipcRenderer.invoke('lsp:servers') as Promise<LanguageServerInfo[]>,
    onServersChanged: (cb) => listen('lsp:servers-changed', cb),
    open: (paneId, filePath) =>
      ipcRenderer.invoke('lsp:open', paneId, filePath) as Promise<LspSessionInfo[]>,
    send: (sessionId, message) => ipcRenderer.send('lsp:send', sessionId, message),
    release: (sessionId) => ipcRenderer.send('lsp:release', sessionId),
    onMessage: (sessionId, cb) => listen(`lsp:msg:${sessionId}`, cb),
    onExit: (sessionId, cb) => listen(`lsp:exit:${sessionId}`, () => cb()),
    setEnabled: (serverKey, enabled) =>
      ipcRenderer.invoke('extensions:set-language-server', serverKey, enabled) as Promise<
        LanguageServerInfo[]
      >,
    restart: (serverKey) => ipcRenderer.invoke('lsp:restart', serverKey) as Promise<void>,
    log: (serverKey) => ipcRenderer.invoke('lsp:log', serverKey) as Promise<LspLog>,
    fetch: (serverKey) => ipcRenderer.invoke('lsp:fetch', serverKey) as Promise<void>,
    removeDownload: (serverKey) =>
      ipcRenderer.invoke('lsp:remove-download', serverKey) as Promise<void>,
    setOverride: (serverKey, override) =>
      ipcRenderer.invoke(
        'extensions:set-language-server-program',
        serverKey,
        override,
      ) as Promise<LanguageServerOverrideResult>,
  },
  editorLanguages: {
    load: () => ipcRenderer.invoke('editorLanguages:load') as Promise<EditorLanguage[]>,
  },
}

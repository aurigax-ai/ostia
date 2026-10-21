import type { ExtensionOpenTerminalRequest } from '@aurigax-ai/ostia-extension-sdk/contract/extensionsBridge'
import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const extensionsBridge: Pick<
  OstiaBridge,
  'marketplace' | 'suggestions' | 'extensions' | 'iconThemes' | 'languagePacks' | 'keymaps'
> = {
  marketplace: {
    list: () => ipcRenderer.invoke('marketplace:list'),
    add: (url) => ipcRenderer.invoke('marketplace:add', url),
    remove: (id, uninstallExtensions) =>
      ipcRenderer.invoke('marketplace:remove', id, uninstallExtensions),
    refresh: (id) => ipcRenderer.invoke('marketplace:refresh', id),
    install: (id, extId) => ipcRenderer.invoke('marketplace:install', id, extId),
    findCode: (code) => ipcRenderer.invoke('marketplace:find-code', code),
    installCode: (id, code) => ipcRenderer.invoke('marketplace:install-code', id, code),
    uninstall: (extId) => ipcRenderer.invoke('marketplace:uninstall', extId),
  },
  suggestions: {
    forFile: (paneId, path) => ipcRenderer.invoke('suggestions:for-file', paneId, path),
    dismiss: (extId) => ipcRenderer.invoke('suggestions:dismiss', extId),
    install: (extId) => ipcRenderer.invoke('suggestions:install', extId),
  },
  extensions: {
    list: () => ipcRenderer.invoke('extensions:list'),
    setEnabled: (extId, enabled) => ipcRenderer.invoke('extensions:set-enabled', extId, enabled),
    approve: (extId) => ipcRenderer.invoke('extensions:approve', extId),
    invoke: (extId, command, target, argument) =>
      ipcRenderer.invoke('extensions:invoke', extId, command, target, argument),
    panel: (extId, context) => ipcRenderer.invoke('extensions:panel', extId, context),
    sidebarItems: () => ipcRenderer.invoke('extensions:sidebar'),
    panelToolbars: () => ipcRenderer.invoke('extensions:panel-toolbar'),
    inboxEntries: () => ipcRenderer.invoke('extensions:inbox'),
    inboxAction: (extId, workspaceId, id) =>
      ipcRenderer.invoke('extensions:inbox-action', extId, workspaceId, id),
    paneChips: () => ipcRenderer.invoke('extensions:chips'),
    workspaceChips: () => ipcRenderer.invoke('extensions:workspace-chips'),
    setSetting: (extId, key, value) =>
      ipcRenderer.invoke('extensions:set-setting', extId, key, value),
    setSecret: (extId, key, value) =>
      ipcRenderer.invoke('extensions:set-secret', extId, key, value),
    connections: (extId) => ipcRenderer.invoke('extensions:connections', extId),
    saveConnection: (extId, connection) =>
      ipcRenderer.invoke('extensions:save-connection', extId, connection),
    removeConnection: (extId, name) =>
      ipcRenderer.invoke('extensions:remove-connection', extId, name),
    onChanged: (cb) => listen('extensions:changed', cb),
    onSidebar: (cb) => listen('extensions:sidebar', cb),
    onPanelToolbars: (cb) => listen('extensions:panel-toolbar', cb),
    onInbox: (cb) => listen('extensions:inbox', cb),
    onPaneChips: (cb) => listen('extensions:chips', cb),
    onWorkspaceChips: (cb) => listen('extensions:workspace-chips', cb),
    onSettingsStored: (cb) => listen('extensions:settings-stored', cb),
    onOpenPanel: (cb) => listen('extensions:open-panel', cb),
    onOpenDiff: (cb) => listen('extensions:open-diff', cb),
    onOpenTerminal: (cb) =>
      listen<[ExtensionOpenTerminalRequest]>('extensions:open-terminal', (req) =>
        ipcRenderer.send('extensions:open-terminal-result', req.requestId, cb(req)),
      ),
    onAgentOffer: (cb) => listen('extensions:agent-offer', cb),
    onAgentOfferWithdrawn: (cb) => listen('extensions:agent-offer-withdrawn', cb),
    answerAgentOffer: (requestId, paneId) =>
      ipcRenderer.send('extensions:agent-offer-result', requestId, paneId),
    onFocusPane: (cb) => listen('extensions:focus-pane', cb),
  },
  iconThemes: {
    load: (id) => ipcRenderer.invoke('iconThemes:load', id),
  },
  languagePacks: {
    load: () => ipcRenderer.invoke('languagePacks:load'),
  },
  keymaps: {
    load: (ref) => ipcRenderer.invoke('keymaps:load', ref),
  },
}

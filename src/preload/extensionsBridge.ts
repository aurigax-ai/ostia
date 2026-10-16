import type {
  ExtensionConnectionEntry,
  ExtensionConnectionResult,
  ExtensionInfo,
  ExtensionOpenTerminalRequest,
  ExtensionPanelSource,
  ExtensionResult,
  ExtensionSecretResult,
  ExtensionSettingResult,
  ExtensionSidebarItem,
  PaneChip,
  WorkspaceChip,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { LoadedIconTheme } from '@aurigax-ai/ostia-extension-sdk/contract/iconTheme'
import type { LanguagePack } from '@aurigax-ai/ostia-extension-sdk/contract/languagePack'
import { ipcRenderer } from 'electron'
import type { ExtensionSuggestion } from '../shared/extensions/extensionSuggestions'
import type { MarketplaceResult, MarketplaceState } from '../shared/extensions/marketplace'
import type { KeymapLoad } from '../shared/keyboard/keymapFile'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const extensionsBridge: Pick<
  OstiaBridge,
  'marketplace' | 'suggestions' | 'extensions' | 'iconThemes' | 'languagePacks' | 'keymaps'
> = {
  marketplace: {
    list: () => ipcRenderer.invoke('marketplace:list') as Promise<MarketplaceState>,
    add: (url) => ipcRenderer.invoke('marketplace:add', url) as Promise<MarketplaceResult>,
    remove: (id, uninstallExtensions) =>
      ipcRenderer.invoke(
        'marketplace:remove',
        id,
        uninstallExtensions,
      ) as Promise<MarketplaceResult>,
    refresh: (id) => ipcRenderer.invoke('marketplace:refresh', id) as Promise<MarketplaceResult>,
    install: (id, extId) =>
      ipcRenderer.invoke('marketplace:install', id, extId) as Promise<MarketplaceResult>,
    installCode: (id, code) =>
      ipcRenderer.invoke('marketplace:install-code', id, code) as Promise<MarketplaceResult>,
    uninstall: (extId) =>
      ipcRenderer.invoke('marketplace:uninstall', extId) as Promise<MarketplaceResult>,
  },
  suggestions: {
    forFile: (paneId, path) =>
      ipcRenderer.invoke(
        'suggestions:for-file',
        paneId,
        path,
      ) as Promise<ExtensionSuggestion | null>,
    dismiss: (extId) => ipcRenderer.invoke('suggestions:dismiss', extId) as Promise<void>,
    install: (extId) =>
      ipcRenderer.invoke('suggestions:install', extId) as Promise<MarketplaceResult>,
  },
  extensions: {
    list: () => ipcRenderer.invoke('extensions:list') as Promise<ExtensionInfo[]>,
    setEnabled: (extId, enabled) =>
      ipcRenderer.invoke('extensions:set-enabled', extId, enabled) as Promise<ExtensionInfo[]>,
    approve: (extId) => ipcRenderer.invoke('extensions:approve', extId) as Promise<ExtensionInfo[]>,
    invoke: (extId, command, target, argument) =>
      ipcRenderer.invoke(
        'extensions:invoke',
        extId,
        command,
        target,
        argument,
      ) as Promise<ExtensionResult>,
    panel: (extId, context) =>
      ipcRenderer.invoke('extensions:panel', extId, context) as Promise<ExtensionPanelSource>,
    sidebarItems: () => ipcRenderer.invoke('extensions:sidebar') as Promise<ExtensionSidebarItem[]>,
    paneChips: () => ipcRenderer.invoke('extensions:chips') as Promise<PaneChip[]>,
    workspaceChips: () =>
      ipcRenderer.invoke('extensions:workspace-chips') as Promise<WorkspaceChip[]>,
    setSetting: (extId, key, value) =>
      ipcRenderer.invoke(
        'extensions:set-setting',
        extId,
        key,
        value,
      ) as Promise<ExtensionSettingResult>,
    setSecret: (extId, key, value) =>
      ipcRenderer.invoke(
        'extensions:set-secret',
        extId,
        key,
        value,
      ) as Promise<ExtensionSecretResult>,
    connections: (extId) =>
      ipcRenderer.invoke('extensions:connections', extId) as Promise<ExtensionConnectionEntry[]>,
    saveConnection: (extId, connection) =>
      ipcRenderer.invoke(
        'extensions:save-connection',
        extId,
        connection,
      ) as Promise<ExtensionConnectionResult>,
    removeConnection: (extId, name) =>
      ipcRenderer.invoke(
        'extensions:remove-connection',
        extId,
        name,
      ) as Promise<ExtensionConnectionResult>,
    onChanged: (cb) => listen('extensions:changed', cb),
    onSidebar: (cb) => listen('extensions:sidebar', cb),
    onPaneChips: (cb) => listen('extensions:chips', cb),
    onWorkspaceChips: (cb) => listen('extensions:workspace-chips', cb),
    onSettingsStored: (cb) => listen('extensions:settings-stored', cb),
    onOpenPanel: (cb) => listen('extensions:open-panel', cb),
    onOpenDiff: (cb) => listen('extensions:open-diff', cb),
    onOpenTerminal: (cb) => {
      const handler = (_e: unknown, req: ExtensionOpenTerminalRequest): void =>
        ipcRenderer.send('extensions:open-terminal-result', req.requestId, cb(req))
      ipcRenderer.on('extensions:open-terminal', handler)
      return () => ipcRenderer.removeListener('extensions:open-terminal', handler)
    },
    onAgentOffer: (cb) => listen('extensions:agent-offer', cb),
    onAgentOfferWithdrawn: (cb) => listen('extensions:agent-offer-withdrawn', cb),
    answerAgentOffer: (requestId, paneId) =>
      ipcRenderer.send('extensions:agent-offer-result', requestId, paneId),
    onFocusPane: (cb) => listen('extensions:focus-pane', cb),
  },
  iconThemes: {
    load: (id) => ipcRenderer.invoke('iconThemes:load', id) as Promise<LoadedIconTheme | null>,
  },
  languagePacks: {
    load: () => ipcRenderer.invoke('languagePacks:load') as Promise<LanguagePack[]>,
  },
  keymaps: {
    load: (ref) => ipcRenderer.invoke('keymaps:load', ref) as Promise<KeymapLoad>,
  },
}

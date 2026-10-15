import { ipcRenderer } from 'electron'
import type {
  ExtensionAgentOffer,
  ExtensionConnectionEntry,
  ExtensionConnectionResult,
  ExtensionInfo,
  ExtensionOpenDiffRequest,
  ExtensionOpenPanelRequest,
  ExtensionOpenTerminalRequest,
  ExtensionPanelSource,
  ExtensionResult,
  ExtensionSecretResult,
  ExtensionSettingResult,
  ExtensionSettingsStored,
  ExtensionSidebarItem,
  PaneChip,
  WorkspaceChip,
} from '../shared/extensions'
import type { ExtensionSuggestion } from '../shared/extensions/extensionSuggestions'
import type { MarketplaceResult, MarketplaceState } from '../shared/extensions/marketplace'
import type { LoadedIconTheme } from '../shared/iconTheme'
import type { KeymapLoad } from '../shared/keyboard/keymapFile'
import type { LanguagePack } from '../shared/languagePack'
import type { OstiaBridge } from '../shared/types'

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
    onChanged: (cb) => {
      const handler = (_e: unknown, list: ExtensionInfo[]): void => cb(list)
      ipcRenderer.on('extensions:changed', handler)
      return () => ipcRenderer.removeListener('extensions:changed', handler)
    },
    onSidebar: (cb) => {
      const handler = (_e: unknown, items: ExtensionSidebarItem[]): void => cb(items)
      ipcRenderer.on('extensions:sidebar', handler)
      return () => ipcRenderer.removeListener('extensions:sidebar', handler)
    },
    onPaneChips: (cb) => {
      const handler = (_e: unknown, chips: PaneChip[]): void => cb(chips)
      ipcRenderer.on('extensions:chips', handler)
      return () => ipcRenderer.removeListener('extensions:chips', handler)
    },
    onWorkspaceChips: (cb) => {
      const handler = (_e: unknown, chips: WorkspaceChip[]): void => cb(chips)
      ipcRenderer.on('extensions:workspace-chips', handler)
      return () => ipcRenderer.removeListener('extensions:workspace-chips', handler)
    },
    onSettingsStored: (cb) => {
      const handler = (_e: unknown, update: ExtensionSettingsStored): void => cb(update)
      ipcRenderer.on('extensions:settings-stored', handler)
      return () => ipcRenderer.removeListener('extensions:settings-stored', handler)
    },
    onOpenPanel: (cb) => {
      const handler = (_e: unknown, req: ExtensionOpenPanelRequest): void => cb(req)
      ipcRenderer.on('extensions:open-panel', handler)
      return () => ipcRenderer.removeListener('extensions:open-panel', handler)
    },
    onOpenDiff: (cb) => {
      const handler = (_e: unknown, req: ExtensionOpenDiffRequest): void => cb(req)
      ipcRenderer.on('extensions:open-diff', handler)
      return () => ipcRenderer.removeListener('extensions:open-diff', handler)
    },
    onOpenTerminal: (cb) => {
      const handler = (_e: unknown, req: ExtensionOpenTerminalRequest): void =>
        ipcRenderer.send('extensions:open-terminal-result', req.requestId, cb(req))
      ipcRenderer.on('extensions:open-terminal', handler)
      return () => ipcRenderer.removeListener('extensions:open-terminal', handler)
    },
    onAgentOffer: (cb) => {
      const handler = (_e: unknown, offer: ExtensionAgentOffer): void => cb(offer)
      ipcRenderer.on('extensions:agent-offer', handler)
      return () => ipcRenderer.removeListener('extensions:agent-offer', handler)
    },
    onAgentOfferWithdrawn: (cb) => {
      const handler = (_e: unknown, requestId: string): void => cb(requestId)
      ipcRenderer.on('extensions:agent-offer-withdrawn', handler)
      return () => ipcRenderer.removeListener('extensions:agent-offer-withdrawn', handler)
    },
    answerAgentOffer: (requestId, paneId) =>
      ipcRenderer.send('extensions:agent-offer-result', requestId, paneId),
    onFocusPane: (cb) => {
      const handler = (_e: unknown, paneId: string): void => cb(paneId)
      ipcRenderer.on('extensions:focus-pane', handler)
      return () => ipcRenderer.removeListener('extensions:focus-pane', handler)
    },
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

import { contextBridge, ipcRenderer } from 'electron'
import type {
  ExtensionInfo,
  ExtensionOpenDiffRequest,
  ExtensionOpenPanelRequest,
  ExtensionPanelSource,
  ExtensionResult,
  ExtensionSidebarItem,
} from '../shared/extensions'
import type { PickOutcome, PickSendResult, PickState } from '../shared/pick'
import type { SelectionSendResult } from '../shared/selection'
import type {
  AppInfo,
  AppSnapshot,
  CommandInvokeRequest,
  ExternalEditorResult,
  FsBinaryResult,
  FsEntry,
  FsKind,
  GatewayBindOptions,
  GatewayDevice,
  GatewayEnableResult,
  GatewayPairResult,
  GatewaySetCapResult,
  GatewayStatus,
  LspServerInfo,
  LspStartResult,
  NotificationEntry,
  PineBridge,
  Platform,
  PtyAttachResult,
  SyncStatus,
} from '../shared/types'

const bridge: PineBridge = {
  ping: () => ipcRenderer.invoke('app:ping') as Promise<'pong'>,
  info: () => ipcRenderer.invoke('app:info') as Promise<AppInfo>,
  platform: process.platform as Platform,
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
    onMaximizeChange: (cb) => {
      const handler = (_event: unknown, maximized: boolean): void => cb(maximized)
      ipcRenderer.on('window:maximized', handler)
      return () => ipcRenderer.removeListener('window:maximized', handler)
    },
  },
  pty: {
    attach: (paneId, opts) =>
      ipcRenderer.invoke('pty:attach', paneId, opts) as Promise<PtyAttachResult>,
    detach: (paneId) => ipcRenderer.send('pty:detach', paneId),
    write: (paneId, data) => ipcRenderer.send('pty:write', paneId, data),
    resize: (paneId, cols, rows) => ipcRenderer.send('pty:resize', paneId, cols, rows),
    onData: (paneId, cb) => {
      const handler = (_e: unknown, data: string): void => cb(data)
      ipcRenderer.on(`pty:data:${paneId}`, handler)
      return () => ipcRenderer.removeListener(`pty:data:${paneId}`, handler)
    },
    onExit: (paneId, cb) => {
      const handler = (_e: unknown, code: number): void => cb(code)
      ipcRenderer.on(`pty:exit:${paneId}`, handler)
      return () => ipcRenderer.removeListener(`pty:exit:${paneId}`, handler)
    },
  },
  fs: {
    list: (path) => ipcRenderer.invoke('fs:list', path) as Promise<FsEntry[]>,
    read: (path) => ipcRenderer.invoke('fs:read', path) as Promise<string | null>,
    stat: (path) => ipcRenderer.invoke('fs:stat', path) as Promise<FsKind | null>,
    write: (path, content) => ipcRenderer.invoke('fs:write', path, content) as Promise<boolean>,
    readBinary: (path) => ipcRenderer.invoke('fs:read-binary', path) as Promise<FsBinaryResult>,
  },
  lsp: {
    list: () => ipcRenderer.invoke('lsp:list') as Promise<LspServerInfo[]>,
    start: (languageId, filePath) =>
      ipcRenderer.invoke('lsp:start', languageId, filePath) as Promise<LspStartResult | null>,
    send: (id, message) => ipcRenderer.send('lsp:send', id, message),
    stop: (id) => ipcRenderer.send('lsp:stop', id),
    onMessage: (id, cb) => {
      const handler = (_e: unknown, message: unknown): void => cb(message)
      ipcRenderer.on(`lsp:msg:${id}`, handler)
      return () => ipcRenderer.removeListener(`lsp:msg:${id}`, handler)
    },
    onExit: (id, cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(`lsp:exit:${id}`, handler)
      return () => ipcRenderer.removeListener(`lsp:exit:${id}`, handler)
    },
  },
  settings: {
    path: () => ipcRenderer.invoke('settings:path') as Promise<string>,
    onChanged: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('settings:changed', handler)
      return () => ipcRenderer.removeListener('settings:changed', handler)
    },
  },
  sync: {
    status: () => ipcRenderer.invoke('sync:status') as Promise<SyncStatus>,
    run: () => ipcRenderer.invoke('sync:run') as Promise<SyncStatus>,
    pickFolder: () => ipcRenderer.invoke('dialog:pick-folder') as Promise<string | null>,
    onStatus: (cb) => {
      const handler = (_e: unknown, status: SyncStatus): void => cb(status)
      ipcRenderer.on('sync:status', handler)
      return () => ipcRenderer.removeListener('sync:status', handler)
    },
  },
  workspace: {
    save: (snapshot) => ipcRenderer.send('workspace:save', snapshot),
    load: () => ipcRenderer.invoke('workspace:load') as Promise<AppSnapshot | null>,
  },
  lifecycle: {
    emit: (event) => ipcRenderer.send('lifecycle:event', event),
  },
  commands: {
    publish: (descriptors) => ipcRenderer.send('commands:register', descriptors),
    onInvoke: (handler) => {
      const listener = async (
        _e: unknown,
        reqId: string,
        req: CommandInvokeRequest,
      ): Promise<void> => {
        const result = await handler(req)
        ipcRenderer.send('command:result', reqId, result)
      }
      ipcRenderer.on('command:invoke', listener)
      return () => ipcRenderer.removeListener('command:invoke', listener)
    },
  },
  terminalState: {
    push: (snapshot) => ipcRenderer.send('terminal:state', snapshot),
  },
  browser: {
    register: (paneId, webContentsId) =>
      ipcRenderer.send('browser:register', paneId, webContentsId),
    unregister: (paneId) => ipcRenderer.send('browser:unregister', paneId),
    pickStart: (paneId, theme) =>
      ipcRenderer.invoke('browser:pick-start', paneId, theme) as Promise<PickOutcome>,
    pickCancel: (paneId) => ipcRenderer.send('browser:pick-cancel', paneId),
    pickSend: (req) => ipcRenderer.invoke('browser:pick-send', req) as Promise<PickSendResult>,
    onPickState: (cb) => {
      const handler = (_e: unknown, state: PickState): void => cb(state)
      ipcRenderer.on('browser:pick-state', handler)
      return () => ipcRenderer.removeListener('browser:pick-state', handler)
    },
  },
  selection: {
    send: (req) => ipcRenderer.invoke('selection:send', req) as Promise<SelectionSendResult>,
  },
  extensions: {
    list: () => ipcRenderer.invoke('extensions:list') as Promise<ExtensionInfo[]>,
    setEnabled: (extId, enabled) =>
      ipcRenderer.invoke('extensions:set-enabled', extId, enabled) as Promise<ExtensionInfo[]>,
    approve: (extId) => ipcRenderer.invoke('extensions:approve', extId) as Promise<ExtensionInfo[]>,
    invoke: (extId, command, target) =>
      ipcRenderer.invoke('extensions:invoke', extId, command, target) as Promise<ExtensionResult>,
    panel: (extId, context) =>
      ipcRenderer.invoke('extensions:panel', extId, context) as Promise<ExtensionPanelSource>,
    sidebarItems: () => ipcRenderer.invoke('extensions:sidebar') as Promise<ExtensionSidebarItem[]>,
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
  },
  externalEditor: {
    open: (req) => ipcRenderer.invoke('editor:open-external', req) as Promise<ExternalEditorResult>,
  },
  gateway: {
    enable: (opts) => ipcRenderer.invoke('gateway:enable', opts) as Promise<GatewayEnableResult>,
    disable: () => ipcRenderer.invoke('gateway:disable') as Promise<{ ok: true }>,
    pair: () => ipcRenderer.invoke('gateway:pair') as Promise<GatewayPairResult>,
    status: () => ipcRenderer.invoke('gateway:status') as Promise<GatewayStatus>,
    devices: () => ipcRenderer.invoke('gateway:devices') as Promise<{ devices: GatewayDevice[] }>,
    revoke: (deviceId) =>
      ipcRenderer.invoke('gateway:revoke', { deviceId }) as Promise<{
        ok: boolean
        error?: string
      }>,
    setCap: (deviceId, cap, granted) =>
      ipcRenderer.invoke('gateway:set-cap', {
        deviceId,
        cap,
        granted,
      }) as Promise<GatewaySetCapResult>,
    bindOptions: () => ipcRenderer.invoke('gateway:bind-options') as Promise<GatewayBindOptions>,
  },
  notifications: {
    list: () => ipcRenderer.invoke('notifications:list') as Promise<NotificationEntry[]>,
    post: (post) => ipcRenderer.send('notifications:post', post),
    clear: () => ipcRenderer.send('notifications:clear'),
    onChanged: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('notifications:changed', handler)
      return () => ipcRenderer.removeListener('notifications:changed', handler)
    },
    onActivate: (cb) => {
      const handler = (_e: unknown, paneId: string): void => cb(paneId)
      ipcRenderer.on('notifications:activate', handler)
      return () => ipcRenderer.removeListener('notifications:activate', handler)
    },
  },
}

contextBridge.exposeInMainWorld('pine', bridge)

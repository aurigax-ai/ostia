import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  CommandInvokeRequest,
  FsEntry,
  GatewayBindOptions,
  GatewayDevice,
  GatewayEnableResult,
  GatewayPairResult,
  GatewaySetCapResult,
  GatewayStatus,
  KanbanBoard,
  KanbanFailure,
  KanbanMutateOp,
  KanbanMutateResult,
  LspServerInfo,
  LspStartResult,
  NotificationEntry,
  PineBridge,
  Platform,
  PtyAttachResult,
  WikiFailure,
  WikiPage,
  WikiPageSummary,
  WikiScope,
  WorkspaceSnapshot,
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
    write: (path, content) => ipcRenderer.invoke('fs:write', path, content) as Promise<boolean>,
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
  },
  session: {
    save: (snapshot) => ipcRenderer.send('session:save', snapshot),
    load: () => ipcRenderer.invoke('session:load') as Promise<WorkspaceSnapshot | null>,
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
  },
  kanban: {
    get: (workDir) =>
      ipcRenderer.invoke('kanban:get', { workDir }) as Promise<KanbanBoard | KanbanFailure>,
    mutate: (workDir, op: KanbanMutateOp) =>
      ipcRenderer.invoke('kanban:mutate', { workDir, op }) as Promise<KanbanMutateResult>,
  },
  wiki: {
    list: (params: { scope?: WikiScope; workDir: string }) =>
      ipcRenderer.invoke('wiki:list', params) as Promise<{ pages: WikiPageSummary[] }>,
    get: (params: { slug: string; scope?: WikiScope; workDir: string }) =>
      ipcRenderer.invoke('wiki:get', params) as Promise<WikiPage | WikiFailure>,
    set: (params: {
      slug: string
      body: string
      title?: string
      scope?: WikiScope
      workDir: string
    }) => ipcRenderer.invoke('wiki:set', params) as Promise<{ ok: true } | WikiFailure>,
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

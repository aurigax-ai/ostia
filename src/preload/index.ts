import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  CommandInvokeRequest,
  FsEntry,
  LspServerInfo,
  LspStartResult,
  PaneDescriptor,
  PineBridge,
  Platform,
  PtyAttachResult,
} from '../shared/types'

/**
 * The single, minimal, typed surface the renderer can touch.
 * Everything privileged stays in main; this just forwards typed requests.
 */
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
    tearOffPane: (descriptor: PaneDescriptor) =>
      ipcRenderer.invoke('window:tear-off', descriptor) as Promise<{ detached: boolean }>,
    getDetachedPane: () =>
      ipcRenderer.invoke('window:get-detached-pane') as Promise<PaneDescriptor | null>,
  },
  pty: {
    attach: (paneId, opts) =>
      ipcRenderer.invoke('pty:attach', paneId, opts) as Promise<PtyAttachResult>,
    detach: (paneId) => ipcRenderer.send('pty:detach', paneId),
    write: (paneId, data) => ipcRenderer.send('pty:write', paneId, data),
    resize: (paneId, cols, rows) => ipcRenderer.send('pty:resize', paneId, cols, rows),
    kill: (paneId) => ipcRenderer.send('pty:kill', paneId),
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
}

contextBridge.exposeInMainWorld('pine', bridge)

import { ipcRenderer } from 'electron'
import type {
  ClipboardContents,
  OriginAgents,
  OstiaBridge,
  QuitQuestion,
  ReferenceInsert,
  SnapshotWorkspace,
  WindowInfo,
  WindowSummary,
} from '../shared/types'

export const windowBridge: Pick<
  OstiaBridge,
  'window' | 'windows' | 'lifecycle' | 'appMenu' | 'clipboard'
> = {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    quit: () => ipcRenderer.send('window:quit'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
    setZoom: (percent) => ipcRenderer.invoke('window:set-zoom', percent) as Promise<number>,
    beep: () => ipcRenderer.send('window:beep'),
    writePrimarySelection: (text) => ipcRenderer.send('window:write-primary', text),
    isSystemDark: () => ipcRenderer.invoke('window:system-dark') as Promise<boolean>,
    onSystemDarkChange: (cb) => {
      const handler = (_event: unknown, dark: boolean): void => cb(dark)
      ipcRenderer.on('window:system-dark-changed', handler)
      return () => ipcRenderer.removeListener('window:system-dark-changed', handler)
    },
    onMaximizeChange: (cb) => {
      const handler = (_event: unknown, maximized: boolean): void => cb(maximized)
      ipcRenderer.on('window:maximized', handler)
      return () => ipcRenderer.removeListener('window:maximized', handler)
    },
    onRunningQuery: (cb) => {
      const handler = (_event: unknown, requestId: number, kept: string[]): void => {
        void Promise.resolve(cb(kept)).then((groups) =>
          ipcRenderer.send('window:close-answer', requestId, groups),
        )
      }
      ipcRenderer.on('window:running', handler)
      return () => ipcRenderer.removeListener('window:running', handler)
    },
    onConfirmClose: (cb) => {
      const handler = (_event: unknown, requestId: number, question: QuitQuestion): void => {
        void cb(question).then((answer) =>
          ipcRenderer.send('window:close-answer', requestId, answer),
        )
      }
      ipcRenderer.on('window:confirm-close', handler)
      return () => ipcRenderer.removeListener('window:confirm-close', handler)
    },
    onFreeze: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('window:freeze', handler)
      return () => ipcRenderer.removeListener('window:freeze', handler)
    },
  },
  windows: {
    info: () => ipcRenderer.invoke('windows:info') as Promise<WindowInfo>,
    detach: (workspace, at) =>
      ipcRenderer.invoke('windows:detach', workspace, at) as Promise<boolean>,
    dropPane: (drop) => ipcRenderer.send('windows:drop-pane', drop),
    landing: (paneId) => ipcRenderer.invoke('windows:landing', paneId) as Promise<boolean>,
    give: (workspace) => ipcRenderer.invoke('windows:give', workspace) as Promise<boolean>,
    returnToMain: (workspaces) =>
      ipcRenderer.invoke('windows:return', workspaces) as Promise<boolean>,
    openWith: (workspaces) =>
      ipcRenderer.invoke('windows:open-with', workspaces) as Promise<boolean>,
    report: (workspaces) => ipcRenderer.send('windows:report', workspaces),
    focusWorkspace: (workspaceId, jumpToUnread) =>
      ipcRenderer.send('windows:focus-workspace', workspaceId, jumpToUnread),
    returnWorkspace: (workspaceId) => ipcRenderer.send('windows:return-workspace', workspaceId),
    newWorkspace: (request) => ipcRenderer.send('windows:new-workspace', request),
    onList: (cb) => {
      const handler = (_e: unknown, list: WindowSummary[]): void => cb(list)
      ipcRenderer.on('windows:list', handler)
      return () => ipcRenderer.removeListener('windows:list', handler)
    },
    onAdopt: (cb) => {
      const handler = (_e: unknown, workspaces: SnapshotWorkspace[]): void => cb(workspaces)
      ipcRenderer.on('windows:adopt', handler)
      return () => ipcRenderer.removeListener('windows:adopt', handler)
    },
    onActivateWorkspace: (cb) => {
      const handler = (_e: unknown, workspaceId: string, jumpToUnread: boolean): void =>
        cb(workspaceId, jumpToUnread)
      ipcRenderer.on('windows:activate-workspace', handler)
      return () => ipcRenderer.removeListener('windows:activate-workspace', handler)
    },
    onReturnRequest: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('windows:return-request', handler)
      return () => ipcRenderer.removeListener('windows:return-request', handler)
    },
    originAgents: (workspaceId) =>
      ipcRenderer.invoke('windows:origin-agents', workspaceId) as Promise<OriginAgents | null>,
    onOriginAgentsChanged: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('windows:origin-agents-changed', handler)
      return () => ipcRenderer.removeListener('windows:origin-agents-changed', handler)
    },
    insertReference: (request) =>
      ipcRenderer.invoke('windows:insert-reference', request) as Promise<boolean>,
    onInsertReference: (cb) => {
      const handler = (_e: unknown, insert: ReferenceInsert): void => cb(insert)
      ipcRenderer.on('windows:reference-insert', handler)
      return () => ipcRenderer.removeListener('windows:reference-insert', handler)
    },
    answerInsertReference: (requestId, inserted) =>
      ipcRenderer.send('windows:reference-inserted', requestId, inserted),
  },
  lifecycle: {
    emit: (event) => ipcRenderer.send('lifecycle:event', event),
  },
  appMenu: {
    set: (spec) => ipcRenderer.send('app-menu:set', spec),
    onRun: (cb) => {
      const listener = (_e: unknown, command: string): void => cb(command)
      ipcRenderer.on('app-menu:run', listener)
      return () => ipcRenderer.removeListener('app-menu:run', listener)
    },
  },
  clipboard: {
    edit: (edit) => ipcRenderer.invoke('clipboard:edit', edit) as Promise<void>,
    contents: () => ipcRenderer.invoke('clipboard:contents') as Promise<ClipboardContents>,
    setChords: (chords) => ipcRenderer.send('clipboard:set-chords', chords),
  },
}

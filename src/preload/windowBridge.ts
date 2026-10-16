import { ipcRenderer } from 'electron'
import type { ClipboardContents } from '../shared/app/appApi'
import type { OriginAgents, QuitQuestion, WindowInfo } from '../shared/windows/windowsApi'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

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
    onSystemDarkChange: (cb) => listen('window:system-dark-changed', cb),
    onMaximizeChange: (cb) => listen('window:maximized', cb),
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
    onFreeze: (cb) => listen('window:freeze', () => cb()),
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
    focusWorkspace: (workspaceId, jumpToUnread, takesKeyboard) =>
      ipcRenderer.send('windows:focus-workspace', workspaceId, jumpToUnread, takesKeyboard),
    returnWorkspace: (workspaceId) => ipcRenderer.send('windows:return-workspace', workspaceId),
    newWorkspace: (request) => ipcRenderer.send('windows:new-workspace', request),
    onList: (cb) => listen('windows:list', cb),
    onAdopt: (cb) => listen('windows:adopt', cb),
    onActivateWorkspace: (cb) => listen('windows:activate-workspace', cb),
    onReturnRequest: (cb) => listen('windows:return-request', () => cb()),
    originAgents: (workspaceId) =>
      ipcRenderer.invoke('windows:origin-agents', workspaceId) as Promise<OriginAgents | null>,
    onOriginAgentsChanged: (cb) => listen('windows:origin-agents-changed', () => cb()),
    insertReference: (request) =>
      ipcRenderer.invoke('windows:insert-reference', request) as Promise<boolean>,
    onInsertReference: (cb) => listen('windows:reference-insert', cb),
    answerInsertReference: (requestId, inserted) =>
      ipcRenderer.send('windows:reference-inserted', requestId, inserted),
  },
  lifecycle: {
    emit: (event) => ipcRenderer.send('lifecycle:event', event),
  },
  appMenu: {
    set: (spec) => ipcRenderer.send('app-menu:set', spec),
    onRun: (cb) => listen('app-menu:run', cb),
  },
  clipboard: {
    edit: (edit) => ipcRenderer.invoke('clipboard:edit', edit) as Promise<void>,
    contents: () => ipcRenderer.invoke('clipboard:contents') as Promise<ClipboardContents>,
    setChords: (chords) => ipcRenderer.send('clipboard:set-chords', chords),
  },
}

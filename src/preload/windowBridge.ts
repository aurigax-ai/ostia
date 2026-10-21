import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { answer, listen } from './listen'

export const windowBridge: Pick<
  OstiaBridge,
  'window' | 'windows' | 'lifecycle' | 'appMenu' | 'clipboard'
> = {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    quit: () => ipcRenderer.send('window:quit'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    setZoom: (percent) => ipcRenderer.invoke('window:set-zoom', percent),
    beep: () => ipcRenderer.send('window:beep'),
    writePrimarySelection: (text) => ipcRenderer.send('window:write-primary', text),
    isSystemDark: () => ipcRenderer.invoke('window:system-dark'),
    onSystemDarkChange: (cb) => listen('window:system-dark-changed', cb),
    onMaximizeChange: (cb) => listen('window:maximized', cb),
    onRunningQuery: (cb) => answer('window:running', 'window:close-answer', cb),
    onConfirmClose: (cb) => answer('window:confirm-close', 'window:close-answer', cb),
    onFreeze: (cb) => listen('window:freeze', () => cb()),
  },
  windows: {
    info: () => ipcRenderer.invoke('windows:info'),
    detach: (workspace, at) => ipcRenderer.invoke('windows:detach', workspace, at),
    dropPane: (drop) => ipcRenderer.send('windows:drop-pane', drop),
    landing: (paneId) => ipcRenderer.invoke('windows:landing', paneId),
    give: (workspace) => ipcRenderer.invoke('windows:give', workspace),
    returnToMain: (workspaces) => ipcRenderer.invoke('windows:return', workspaces),
    openWith: (workspaces) => ipcRenderer.invoke('windows:open-with', workspaces),
    report: (workspaces) => ipcRenderer.send('windows:report', workspaces),
    focusWorkspace: (workspaceId, jumpToUnread, takesKeyboard) =>
      ipcRenderer.send('windows:focus-workspace', workspaceId, jumpToUnread, takesKeyboard),
    returnWorkspace: (workspaceId) => ipcRenderer.send('windows:return-workspace', workspaceId),
    newWorkspace: (request) => ipcRenderer.send('windows:new-workspace', request),
    onList: (cb) => listen('windows:list', cb),
    onAdopt: (cb) => listen('windows:adopt', cb),
    onActivateWorkspace: (cb) => listen('windows:activate-workspace', cb),
    onReturnRequest: (cb) => listen('windows:return-request', () => cb()),
    originAgents: (workspaceId) => ipcRenderer.invoke('windows:origin-agents', workspaceId),
    onOriginAgentsChanged: (cb) => listen('windows:origin-agents-changed', () => cb()),
    insertReference: (request) => ipcRenderer.invoke('windows:insert-reference', request),
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
    edit: (edit) => ipcRenderer.invoke('clipboard:edit', edit),
    contents: () => ipcRenderer.invoke('clipboard:contents'),
    setChords: (chords) => ipcRenderer.send('clipboard:set-chords', chords),
    writeCapture: (capture) => ipcRenderer.invoke('clipboard:write-capture', capture),
  },
}

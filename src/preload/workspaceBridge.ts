import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const workspaceBridge: Pick<OstiaBridge, 'workspace' | 'scratch' | 'snippets' | 'views'> = {
  workspace: {
    save: (snapshot) => ipcRenderer.send('workspace:save', snapshot),
    load: () => ipcRenderer.invoke('workspace:load'),
    merge: (sourceId, targetId) => ipcRenderer.invoke('workspace:merge', sourceId, targetId),
    movePanes: (sourceId, targetId, paneIds) =>
      ipcRenderer.invoke('workspace:move-panes', sourceId, targetId, paneIds),
    readCmux: (path) => ipcRenderer.invoke('workspace:read-cmux', path),
    isRemote: (workspaceId) => ipcRenderer.invoke('workspace:is-remote', workspaceId),
  },
  scratch: {
    create: () => ipcRenderer.invoke('scratch:create'),
    files: (workspaceId) => ipcRenderer.invoke('scratch:files', workspaceId),
    reveal: (workspaceId) => ipcRenderer.send('scratch:reveal', workspaceId),
  },
  snippets: {
    list: (workspaceId) => ipcRenderer.invoke('snippets:list', workspaceId),
    save: (doc) => ipcRenderer.invoke('snippets:save', doc),
  },
  views: {
    list: () => ipcRenderer.invoke('views:list'),
    setEnabled: (name, enabled) => ipcRenderer.invoke('views:set-enabled', name, enabled),
    reveal: (name) => ipcRenderer.invoke('views:reveal', name),
    onChanged: (cb) => listen('views:changed', cb),
  },
}

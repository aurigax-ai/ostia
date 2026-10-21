import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const artifactsBridge: Pick<OstiaBridge, 'artifacts' | 'preview'> = {
  artifacts: {
    list: (workspaceId) => ipcRenderer.invoke('artifacts:list', workspaceId),
    pad: (workspaceId) => ipcRenderer.invoke('artifacts:pad', workspaceId),
    reveal: (workspaceId) => ipcRenderer.send('artifacts:reveal', workspaceId),
    portable: (action, request) => {
      const channel =
        action === 'open'
          ? 'artifacts:portable-open'
          : action === 'save'
            ? 'artifacts:portable-save'
            : 'artifacts:portable-copy'
      return ipcRenderer.invoke(channel, request)
    },
    versions: (workspaceId, path) => ipcRenderer.invoke('artifacts:versions', workspaceId, path),
    version: (workspaceId, path, id) =>
      ipcRenderer.invoke('artifacts:version', workspaceId, path, id),
    restore: (workspaceId, path, id) =>
      ipcRenderer.invoke('artifacts:restore', workspaceId, path, id),
    producers: (workspaceId) => ipcRenderer.invoke('artifacts:producers', workspaceId),
    onChanged: (cb) => listen('artifacts:changed', cb),
  },
  preview: {
    open: (paneId, path, theme) => ipcRenderer.invoke('preview:open', paneId, path, theme),
    shown: (id, visible) => ipcRenderer.send('preview:shown', id, visible),
    stop: (id) => ipcRenderer.send('preview:stop', id),
    close: (id) => ipcRenderer.send('preview:close', id),
    capture: (id, rect) => ipcRenderer.invoke('preview:capture', id, rect),
    onEvent: (cb) => listen('preview:event', cb),
  },
}

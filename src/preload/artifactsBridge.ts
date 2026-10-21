import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const artifactsBridge: Pick<OstiaBridge, 'artifacts' | 'preview' | 'shares'> = {
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
            : action === 'copy'
              ? 'artifacts:portable-copy'
              : 'artifacts:portable-publish'
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
  shares: {
    status: () => ipcRenderer.invoke('shares:status'),
    list: () => ipcRenderer.invoke('shares:list'),
    copyLink: (id) => ipcRenderer.invoke('shares:copy-link', id),
    remove: (id) => ipcRenderer.invoke('shares:delete', id),
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

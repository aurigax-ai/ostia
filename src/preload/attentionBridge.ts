import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const attentionBridge: Pick<OstiaBridge, 'notifications'> = {
  notifications: {
    list: () => ipcRenderer.invoke('notifications:list'),
    post: (post) => ipcRenderer.send('notifications:post', post),
    clear: () => ipcRenderer.send('notifications:clear'),
    reveal: (paneId) => ipcRenderer.send('notifications:reveal', paneId),
    onChanged: (cb) => listen('notifications:changed', () => cb()),
    onActivate: (cb) => listen('notifications:activate', cb),
  },
}

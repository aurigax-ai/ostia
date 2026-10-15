import { ipcRenderer } from 'electron'
import type { NotificationEntry, OstiaBridge } from '../shared/types'

export const attentionBridge: Pick<OstiaBridge, 'notifications'> = {
  notifications: {
    list: () => ipcRenderer.invoke('notifications:list') as Promise<NotificationEntry[]>,
    post: (post) => ipcRenderer.send('notifications:post', post),
    clear: () => ipcRenderer.send('notifications:clear'),
    reveal: (paneId) => ipcRenderer.send('notifications:reveal', paneId),
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

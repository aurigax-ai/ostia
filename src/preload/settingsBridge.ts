import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import type { SyncStatus } from '../shared/profileSync/profileSync'
import { listen } from './listen'

export const settingsBridge: Pick<OstiaBridge, 'settings' | 'sync'> = {
  settings: {
    path: () => ipcRenderer.invoke('settings:path') as Promise<string>,
    onChanged: (cb) => listen('settings:changed', () => cb()),
  },
  sync: {
    status: () => ipcRenderer.invoke('sync:status') as Promise<SyncStatus>,
    run: () => ipcRenderer.invoke('sync:run') as Promise<SyncStatus>,
    resolve: (conflictId) => ipcRenderer.invoke('sync:resolve', conflictId) as Promise<SyncStatus>,
    install: (extId) => ipcRenderer.invoke('sync:install', extId) as Promise<SyncStatus>,
    secrets: {
      reveal: (conflictId) => ipcRenderer.invoke('sync:secrets-reveal', conflictId),
      enable: () => ipcRenderer.invoke('sync:secrets-enable'),
      disable: () => ipcRenderer.invoke('sync:secrets-disable'),
      remove: () => ipcRenderer.invoke('sync:secrets-remove'),
      setLogins: (on) => ipcRenderer.invoke('sync:secrets-logins', on ? 'on' : 'off'),
      setup: (password, confirm) => ipcRenderer.invoke('sync:secrets-setup', password, confirm),
      reset: (password, confirm) => ipcRenderer.invoke('sync:secrets-reset', password, confirm),
      unlock: (password) => ipcRenderer.invoke('sync:secrets-unlock', password),
      changePassword: (password, confirm) =>
        ipcRenderer.invoke('sync:secrets-change-password', password, confirm),
      recover: (recoveryKey, password, confirm) =>
        ipcRenderer.invoke('sync:secrets-recover', recoveryKey, password, confirm),
    },
    pickFolder: () => ipcRenderer.invoke('dialog:pick-folder') as Promise<string | null>,
    onStatus: (cb) => listen('sync:status', cb),
  },
}

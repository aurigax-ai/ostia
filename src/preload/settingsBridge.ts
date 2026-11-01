import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const settingsBridge: Pick<OstiaBridge, 'settings' | 'sync'> = {
  settings: {
    path: () => ipcRenderer.invoke('settings:path'),
    recovered: () => ipcRenderer.invoke('settings:recovered'),
    onChanged: (cb) => listen('settings:changed', () => cb()),
    setPlaybooks: (playbooks) => ipcRenderer.send('settings:playbooks', playbooks),
  },
  sync: {
    status: () => ipcRenderer.invoke('sync:status'),
    run: () => ipcRenderer.invoke('sync:run'),
    install: (extId) => ipcRenderer.invoke('sync:install', extId),
    secrets: {
      enable: () => ipcRenderer.invoke('sync:secrets-enable'),
      disable: () => ipcRenderer.invoke('sync:secrets-disable'),
      useSyncKey: () => ipcRenderer.invoke('sync:secrets-use-sync-key'),
      setLogins: (on) => ipcRenderer.invoke('sync:secrets-logins', on ? 'on' : 'off'),
      setup: (password, confirm) => ipcRenderer.invoke('sync:secrets-setup', password, confirm),
      reset: (password, confirm) => ipcRenderer.invoke('sync:secrets-reset', password, confirm),
      unlock: (password) => ipcRenderer.invoke('sync:secrets-unlock', password),
      changePassword: (password, confirm) =>
        ipcRenderer.invoke('sync:secrets-change-password', password, confirm),
      recover: (recoveryKey, password, confirm) =>
        ipcRenderer.invoke('sync:secrets-recover', recoveryKey, password, confirm),
    },
    pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
    onStatus: (cb) => listen('sync:status', cb),
  },
}

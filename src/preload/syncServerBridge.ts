import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const syncServerBridge: Pick<OstiaBridge, 'syncServer'> = {
  syncServer: {
    status: () => ipcRenderer.invoke('syncServer:status'),
    setup: (passphrase, confirm) => ipcRenderer.invoke('syncServer:setup', passphrase, confirm),
    unlock: (passphrase) => ipcRenderer.invoke('syncServer:unlock', passphrase),
    recover: (recoveryKey, passphrase, confirm) =>
      ipcRenderer.invoke('syncServer:recover', recoveryKey, passphrase, confirm),
    changePassphrase: (current, next, confirm) =>
      ipcRenderer.invoke('syncServer:change-passphrase', current, next, confirm),
    onStatus: (cb) => listen('syncServer:status', cb),
  },
}

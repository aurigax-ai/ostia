import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const syncServerBridge: Pick<OstiaBridge, 'syncServer'> = {
  syncServer: {
    status: () => ipcRenderer.invoke('syncServer:status'),
    setup: (passphrase, confirm) => ipcRenderer.invoke('syncServer:setup', passphrase, confirm),
    unlock: (passphrase) => ipcRenderer.invoke('syncServer:unlock', passphrase),
    recover: (recoveryKey) => ipcRenderer.invoke('syncServer:recover', recoveryKey),
    linkStart: () => ipcRenderer.invoke('syncServer:link-start'),
    linkStop: () => ipcRenderer.invoke('syncServer:link-stop'),
    linkConfirm: (code) => ipcRenderer.invoke('syncServer:link-confirm', code),
    approveJoin: (deviceId, code) => ipcRenderer.invoke('syncServer:approve-join', deviceId, code),
    removeDevice: (deviceId, passphrase, recoveryKey) =>
      ipcRenderer.invoke('syncServer:remove-device', deviceId, passphrase, recoveryKey),
    rotate: (passphrase, recoveryKey) =>
      ipcRenderer.invoke('syncServer:rotate', passphrase, recoveryKey),
    newRecoveryKey: () => ipcRenderer.invoke('syncServer:new-recovery-key'),
    collectGarbage: () => ipcRenderer.invoke('syncServer:gc'),
    onStatus: (cb) => listen('syncServer:status', cb),
    attention: () => ipcRenderer.invoke('syncServer:attention'),
    onAttention: (cb) => listen('syncServer:attention', cb),
    onOpen: (cb) => listen('syncServer:open', () => cb()),
  },
}

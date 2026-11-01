import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const browserBridge: Pick<
  OstiaBridge,
  'browser' | 'guestChords' | 'guestInput' | 'credentials'
> = {
  browser: {
    claimProfile: (paneId, profile) => ipcRenderer.invoke('browser:claim-profile', paneId, profile),
    register: (paneId, webContentsId) =>
      ipcRenderer.send('browser:register', paneId, webContentsId),
    unregister: (paneId) => ipcRenderer.send('browser:unregister', paneId),
    pickStart: (paneId, theme) => ipcRenderer.invoke('browser:pick-start', paneId, theme),
    pickCancel: (paneId) => ipcRenderer.send('browser:pick-cancel', paneId),
    pickSend: (req) => ipcRenderer.invoke('browser:pick-send', req),
    pickCopy: (paneId, captureId) => ipcRenderer.invoke('browser:pick-copy', paneId, captureId),
    pageSelection: (paneId) => ipcRenderer.invoke('browser:page-selection', paneId),
    onPickState: (cb) => listen('browser:pick-state', cb),
    regionCapture: (paneId, req) => ipcRenderer.invoke('browser:region-capture', paneId, req),
    regionSend: (req) => ipcRenderer.invoke('browser:region-send', req),
    regionCopy: (paneId, captureId) => ipcRenderer.invoke('browser:region-copy', paneId, captureId),
    setDevice: (paneId, device) => ipcRenderer.invoke('browser:set-device', paneId, device),
    deviceTouch: (paneId, input) => ipcRenderer.send('browser:device-touch', paneId, input),
    storageRead: (paneId) => ipcRenderer.invoke('browser:storage-read', paneId),
    storageSet: (paneId, edit) => ipcRenderer.invoke('browser:storage-set', paneId, edit),
    storageRemove: (paneId, removal) =>
      ipcRenderer.invoke('browser:storage-remove', paneId, removal),
    storageClear: (paneId, kind) => ipcRenderer.invoke('browser:storage-clear', paneId, kind),
    onOpenTab: (cb) => listen('browser:open-tab', cb),
  },
  guestChords: {
    set: (signatures) => ipcRenderer.send('guest-chords:set', signatures),
    setRemap: (table) => ipcRenderer.send('guest-chords:remap', table),
    onFire: (cb) => listen('guest-chords:fire', cb),
  },
  guestInput: {
    onPointerDown: (cb) => listen('guest-input:pointer-down', cb),
  },
  credentials: {
    forPage: (paneId) => ipcRenderer.invoke('credentials:for-page', paneId),
    fill: (paneId, id) => ipcRenderer.invoke('credentials:fill', paneId, id),
    saveFromPage: (paneId) => ipcRenderer.invoke('credentials:save-from-page', paneId),
    list: () => ipcRenderer.invoke('credentials:list'),
    save: (input) => ipcRenderer.invoke('credentials:save', input),
    remove: (id) => ipcRenderer.invoke('credentials:remove', id),
    copyPassword: (id) => ipcRenderer.invoke('credentials:copy-password', id),
    import: () => ipcRenderer.invoke('credentials:import'),
  },
}

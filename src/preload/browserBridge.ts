import { ipcRenderer } from 'electron'
import type { BrowserProfile } from '../shared/browser/browserProfile'
import type { BrowserStorageRead, StorageWriteResult } from '../shared/browser/browserStorage'
import type {
  CredentialImportResult,
  CredentialSaveResult,
  CredentialSummary,
} from '../shared/browser/credentials'
import type { PickOutcome, PickSendResult, PickState } from '../shared/browser/pick'
import type { RegionCaptureOutcome, RegionCopyResult } from '../shared/browser/regionCapture'
import type { GuestChordFire } from '../shared/keyboard/guestChords'
import type { CredentialFillResult, OstiaBridge } from '../shared/types'

export const browserBridge: Pick<OstiaBridge, 'browser' | 'guestChords' | 'credentials'> = {
  browser: {
    claimProfile: (paneId, profile) =>
      ipcRenderer.invoke('browser:claim-profile', paneId, profile) as Promise<BrowserProfile>,
    register: (paneId, webContentsId) =>
      ipcRenderer.send('browser:register', paneId, webContentsId),
    unregister: (paneId) => ipcRenderer.send('browser:unregister', paneId),
    pickStart: (paneId, theme) =>
      ipcRenderer.invoke('browser:pick-start', paneId, theme) as Promise<PickOutcome>,
    pickCancel: (paneId) => ipcRenderer.send('browser:pick-cancel', paneId),
    pickSend: (req) => ipcRenderer.invoke('browser:pick-send', req) as Promise<PickSendResult>,
    onPickState: (cb) => {
      const handler = (_e: unknown, state: PickState): void => cb(state)
      ipcRenderer.on('browser:pick-state', handler)
      return () => ipcRenderer.removeListener('browser:pick-state', handler)
    },
    regionCapture: (paneId, req) =>
      ipcRenderer.invoke('browser:region-capture', paneId, req) as Promise<RegionCaptureOutcome>,
    regionSend: (req) => ipcRenderer.invoke('browser:region-send', req) as Promise<PickSendResult>,
    regionCopy: (paneId, captureId) =>
      ipcRenderer.invoke('browser:region-copy', paneId, captureId) as Promise<RegionCopyResult>,
    storageRead: (paneId) =>
      ipcRenderer.invoke('browser:storage-read', paneId) as Promise<BrowserStorageRead>,
    storageSet: (paneId, edit) =>
      ipcRenderer.invoke('browser:storage-set', paneId, edit) as Promise<StorageWriteResult>,
    storageRemove: (paneId, removal) =>
      ipcRenderer.invoke('browser:storage-remove', paneId, removal) as Promise<StorageWriteResult>,
    storageClear: (paneId, kind) =>
      ipcRenderer.invoke('browser:storage-clear', paneId, kind) as Promise<StorageWriteResult>,
  },
  guestChords: {
    set: (signatures) => ipcRenderer.send('guest-chords:set', signatures),
    onFire: (cb) => {
      const handler = (_e: unknown, fire: GuestChordFire): void => cb(fire)
      ipcRenderer.on('guest-chords:fire', handler)
      return () => ipcRenderer.removeListener('guest-chords:fire', handler)
    },
  },
  credentials: {
    forPage: (paneId) =>
      ipcRenderer.invoke('credentials:for-page', paneId) as Promise<CredentialSummary[]>,
    fill: (paneId, id) =>
      ipcRenderer.invoke('credentials:fill', paneId, id) as Promise<CredentialFillResult>,
    saveFromPage: (paneId) =>
      ipcRenderer.invoke('credentials:save-from-page', paneId) as Promise<CredentialSaveResult>,
    list: () => ipcRenderer.invoke('credentials:list') as Promise<CredentialSummary[]>,
    save: (input) => ipcRenderer.invoke('credentials:save', input) as Promise<CredentialSaveResult>,
    remove: (id) => ipcRenderer.invoke('credentials:remove', id) as Promise<boolean>,
    copyPassword: (id) => ipcRenderer.invoke('credentials:copy-password', id) as Promise<boolean>,
    import: () => ipcRenderer.invoke('credentials:import') as Promise<CredentialImportResult>,
  },
}
